// The shared setup of the browser tests: serves one fixture app, parses plans written as raw JSON
// against a trusted project, clears them through the policy gate and runs them with run(). What a
// feature varies (its app, project, seed, clock and drivers) is passed in; a feature's own plan
// builders and routes stay in a small file beside its tests.
import assert from "node:assert/strict";
import { arch, platform } from "node:os";
import {
    defaultRedactor,
    parseProject,
    planParser,
    run,
    type ActionStep,
    type BrowserDriver,
    type Locator,
    type Plan,
    type PlanStanding,
    type Project,
    type RunEventSink,
    type RunInputs,
    type RunResult,
    type SecretStore,
    type Session,
    type Step,
    type Target,
} from "@revisum/engine";
import { startFixtureServer, type FixtureRoute, type FixtureServer } from "../fixture-server.ts";
import {
    memoryArtifactStore,
    memoryEventSink,
    memoryRunEventSink,
    systemClock,
    type MemoryArtifactStore,
    type MemoryEventSink,
} from "../memory-ports.ts";
import { authorise, trustedProjectFrom } from "../policy-clearance.ts";
import { BrowserTarget } from "./BrowserTarget.ts";
import { navigate, testId, visible, type JsonRecord } from "./RawPlan.ts";
import { runningAtClose } from "./WrappingSessions.ts";

export type BrowserHarnessDefinition = {
    readonly fixtureFolder: string;
    // Paths the server answers with what the test builds, ahead of the app's files.
    readonly routes?: ReadonlyMap<string, FixtureRoute>;
    // The project file as a person writes it, for the origin the server got.
    readonly projectFile: (origin: string) => unknown;
    readonly seed: number;
    readonly fixedTimeMilliseconds: number;
    readonly drivers: ReadonlyMap<string, BrowserDriver>;
    readonly planFor: (
        targetId: string,
        steps: readonly unknown[],
        fields?: JsonRecord,
    ) => JsonRecord;
    // Test ids to read at the close of every run; absent, a run does not touch the page at close.
    readonly readAtClose?: readonly string[];
    readonly scriptSources?: Readonly<Record<string, Uint8Array>>;
};

// What the page showed just before the run closed its session: its URL, and the text of each test
// id the run was asked to read (null when that test id matched no single element).
export type PageAtClose = {
    readonly url: string;
    readonly shown: Readonly<Record<string, string | null>>;
};

export type BrowserRun = {
    readonly result: RunResult;
    readonly events: RunEventSink;
    readonly audit: MemoryEventSink;
    readonly store: MemoryArtifactStore;
    // Null when no session opened, or it was never closed.
    readonly atClose: PageAtClose | null;
    // The paths the fixture server was asked for during the run, in order.
    readonly requestedPaths: readonly string[];
    // When the run began, in milliseconds since the epoch, for searching the disk afterwards.
    readonly startedAt: number;
};

export type BrowserRunOptions = {
    // Test ids whose text to read at close, in place of the harness's own.
    readonly read?: readonly string[];
    // Drivers by adapter id, in place of the harness's own.
    readonly drivers?: ReadonlyMap<string, BrowserDriver>;
    // Where the plan's secrets are resolved.
    readonly secrets?: SecretStore;
    // The plan's standing; absent, the run is a proposal.
    readonly standing?: PlanStanding;
    // The script sources the run is given, in place of the harness's own.
    readonly scriptSources?: Readonly<Record<string, Uint8Array>>;
    readonly clockStartMilliseconds?: number;
    // As the session's close() begins, while every file and tab it holds is still there.
    readonly beforePageRead?: (session: Session, startedAt: number) => Promise<void>;
    // After the page is read, when the hook may move the page elsewhere.
    readonly afterPageRead?: (session: Session) => Promise<void>;
};

export type BrowserHarness = {
    readonly server: FixtureServer;
    readonly origin: string;
    readonly project: Project;
    // The harness's own drivers by adapter id, made once.
    readonly drivers: ReadonlyMap<string, BrowserDriver>;
    readonly parse: ReturnType<typeof planParser>;
    plan(raw: unknown): Plan;
    // One locator or action step, parsed by the real parser so a direct session call gets branded values.
    locator(raw: JsonRecord): Locator;
    actionStep(raw: JsonRecord): ActionStep;
    target(targetId: string): Target;
    // Everything a run takes except its plan and target.
    runInputs(): Omit<RunInputs, "plan" | "targetId">;
    run(plan: Plan, targetId: string, options?: BrowserRunOptions): Promise<BrowserRun>;
    // The definition's plan, parsed and run on the target.
    runSteps(
        targetId: string,
        steps: readonly unknown[],
        options?: BrowserRunOptions & { readonly fields?: JsonRecord },
    ): Promise<BrowserRun>;
    // The text a probe of the test id shows on the session's page, or null when it matches no single element.
    shownOn(session: Session, id: string): Promise<string | null>;
    // Resolves the next time a page asks the fixture server for this path.
    requested(path: string): Promise<void>;
    url(path: string): string;
    close(): Promise<void>;
};

const ACTION_STEP_TYPES: readonly string[] = [
    "click",
    "hover",
    "fill",
    "select",
    "upload",
    "press",
    "download",
    "dialog",
];
const isActionStep = (step: Step): step is ActionStep => ACTION_STEP_TYPES.includes(step.type);

function parsedProjectOf(projectFile: unknown): Project {
    const parsed = parseProject(projectFile);
    if (!parsed.ok) {
        throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.value;
}

// The paths the server was asked for, and a way to wait for the next ask of one path.
function requestWatch() {
    const paths: string[] = [];
    const waiting = new Map<string, (() => void)[]>();
    return {
        paths,
        record(path: string): void {
            paths.push(path);
            const waiters = waiting.get(path) ?? [];
            waiting.delete(path);
            for (const resume of waiters) {
                resume();
            }
        },
        requested: (path: string): Promise<void> =>
            new Promise((resolve) => {
                waiting.set(path, [...(waiting.get(path) ?? []), resolve]);
            }),
    };
}

// Parses single steps and locators by putting each in a plan no one runs.
function stepParsers(
    plan: (raw: unknown) => Plan,
    planFor: BrowserHarnessDefinition["planFor"],
): Pick<BrowserHarness, "locator" | "actionStep"> {
    const singleStep = (raw: JsonRecord): Step => {
        const steps = [navigate("/"), raw, visible(testId("input-events"), "probe.page-shown")];
        const step = plan(planFor(BrowserTarget.Chrome, steps)).steps[1];
        assert.ok(step !== undefined);
        return step;
    };
    return {
        locator(raw) {
            const step = singleStep(visible(raw, "probe.located"));
            assert.ok(step.type === "expect");
            return step.locator;
        },
        actionStep(raw) {
            const step = singleStep(raw);
            assert.ok(isActionStep(step), `${step.type} is not an action step`);
            return step;
        },
    };
}

type RunContext = {
    readonly definition: BrowserHarnessDefinition;
    readonly watch: ReturnType<typeof requestWatch>;
    readonly trusted: Awaited<ReturnType<typeof trustedProjectFrom>>;
    readonly target: BrowserHarness["target"];
    readonly runInputs: BrowserHarness["runInputs"];
    readonly shownOn: BrowserHarness["shownOn"];
};

// The drivers a run uses, reading the page into `pages` at each session's close when asked to.
function driversForRun(
    context: RunContext,
    options: BrowserRunOptions,
    startedAt: number,
    pages: PageAtClose[],
): ReadonlyMap<string, BrowserDriver> {
    const chosen = options.drivers ?? context.definition.drivers;
    const testIds = options.read ?? context.definition.readAtClose;
    if (testIds === undefined) {
        return chosen;
    }
    const atClose = async (session: Session): Promise<void> => {
        await options.beforePageRead?.(session, startedAt);
        const shown: Record<string, string | null> = {};
        for (const id of testIds) {
            shown[id] = await context.shownOn(session, id);
        }
        pages.push({ url: (await session.page()).url, shown });
        await options.afterPageRead?.(session);
    };
    return new Map(
        [...chosen].map(([adapter, driver]) => [adapter, runningAtClose(driver, atClose)] as const),
    );
}

async function runPlan(
    context: RunContext,
    plan: Plan,
    targetId: string,
    options: BrowserRunOptions,
): Promise<BrowserRun> {
    const startedAt = Date.now();
    const pages: PageAtClose[] = [];
    const events = memoryRunEventSink();
    const audit = memoryEventSink();
    const store = memoryArtifactStore();
    const firstRequest = context.watch.paths.length;
    const scriptSources = options.scriptSources ?? context.definition.scriptSources;
    const result = await run(
        {
            ...context.runInputs(),
            ...(options.clockStartMilliseconds === undefined
                ? {}
                : { fixedTimeMilliseconds: options.clockStartMilliseconds }),
            plan: authorise(plan, context.trusted, options.standing),
            targetId: context.target(targetId).id,
            ...(scriptSources === undefined ? {} : { scriptSources }),
            ...(options.standing === undefined ? {} : { standing: options.standing }),
        },
        {
            drivers: driversForRun(context, options, startedAt, pages),
            clock: systemClock,
            artifacts: store,
            redactor: defaultRedactor(),
            audit,
            events,
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        },
    );
    return {
        result,
        events,
        audit,
        store,
        atClose: pages[0] ?? null,
        requestedPaths: context.watch.paths.slice(firstRequest),
        startedAt,
    };
}

export async function startBrowserHarness(
    definition: BrowserHarnessDefinition,
): Promise<BrowserHarness> {
    const watch = requestWatch();
    const server = await startFixtureServer(
        definition.fixtureFolder,
        (path) => {
            watch.record(path);
        },
        definition.routes,
    );
    const projectFile = definition.projectFile(server.origin);
    const project = parsedProjectOf(projectFile);
    const trusted = await trustedProjectFrom(projectFile);
    const parse = planParser(project);
    const plan = (raw: unknown): Plan => {
        const parsed = parse(raw);
        if (!parsed.ok) {
            throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
        }
        return parsed.value;
    };
    const { locator, actionStep } = stepParsers(plan, definition.planFor);
    const target = (targetId: string): Target => {
        const found = project.matrix.find((candidate) => candidate.id === targetId);
        assert.ok(found !== undefined, `no target ${targetId}`);
        return found;
    };
    const runInputs = (): Omit<RunInputs, "plan" | "targetId"> => ({
        project,
        baseUrl: server.origin,
        seed: definition.seed,
        fixedTimeMilliseconds: definition.fixedTimeMilliseconds,
        fixtures: server.fixtures,
        host: { platform: platform(), arch: arch() },
    });
    const shownOn = async (session: Session, id: string): Promise<string | null> => {
        const probed = await session.probe(locator(testId(id)));
        return probed.count === 1 ? probed.text : null;
    };
    const context: RunContext = { definition, watch, trusted, target, runInputs, shownOn };
    return {
        server,
        origin: server.origin,
        project,
        drivers: definition.drivers,
        parse,
        plan,
        locator,
        actionStep,
        target,
        runInputs,
        run: (parsedPlan, targetId, options = {}) =>
            runPlan(context, parsedPlan, targetId, options),
        runSteps: (targetId, steps, options = {}) =>
            runPlan(
                context,
                plan(definition.planFor(targetId, steps, options.fields ?? {})),
                targetId,
                options,
            ),
        shownOn,
        requested: watch.requested,
        url: (path) => `${server.origin}${path}`,
        close: () => server.close(),
    };
}

// One step's outcome as [index, outcome, code], the shape the tests compare.
export const outcomes = (
    result: RunResult,
): readonly (readonly [number, string, string | undefined])[] =>
    result.steps.map((step) => [step.index, step.outcome, step.code] as const);

// The real time the step at `index` took.
export function stepMilliseconds(result: RunResult, index: number): number {
    const taken = result.timings.stepMilliseconds[index];
    assert.ok(taken !== undefined, `step ${index} has a timing: ${JSON.stringify(result.timings)}`);
    return taken;
}
