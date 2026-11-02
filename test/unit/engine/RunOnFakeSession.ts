// A run on a session that needs no browser, for tests that decide what the page does at each call:
// the session is typed to the real port, performs every optional feature and shows one element
// reading "Ready" until a test says otherwise. The plan goes through the real parser, policy gate
// and run, under a virtual clock, so a check that waits out its timeout costs no real time.
import assert from "node:assert/strict";
import {
    DRIVER_FEATURES,
    defaultRedactor,
    environmentSecretStore,
    planParser,
    run,
    success,
    type BrowserDriver,
    type ElementProbe,
    type NetworkPort,
    type ObservedExchange,
    type RunResult,
    type Session,
    type StepResult,
} from "@revisum/engine";
import {
    memoryArtifactStore,
    memoryEventSink,
    memoryRunEventSink,
    type MemoryEventSink,
} from "../../support/memory-ports.ts";
import { authorise, trustedProjectFrom } from "../../support/policy-clearance.ts";
import {
    DATABASE_PASSWORD,
    fakeCommandRunner,
    type CommandRoute,
} from "./database-command-examples.ts";
import { fakeServiceCaller, virtualClock, type Route } from "./service-call-examples.ts";
import { DEFAULT_CLOCK_START, DEFAULT_SEED, ORIGIN } from "./run-value-examples.ts";
import { parsedProject, sourceBytes } from "./unsafe-feature-examples.ts";
import { DATABASE_SECRET, unsafeProjectFile, type JsonRecord } from "./unsafe-feature-steps.ts";

export const SHOWN_ELEMENT: ElementProbe = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Ready",
    value: "Ready",
    sensitive: false,
    box: null,
};
export const NO_ELEMENT: ElementProbe = { ...SHOWN_ELEMENT, count: 0, text: "", value: null };

// A session whose frames and tabs are the session itself, unless `changes` says otherwise.
export function fakeSession(changes: Partial<Session> = {}): Session {
    const session: Session = {
        browser: { name: "fake-browser", version: "1.0" },
        navigate: () => Promise.resolve(success(undefined)),
        page: () => Promise.resolve({ url: `${ORIGIN}/orders`, title: "Orders" }),
        act: () => Promise.resolve(success(undefined)),
        probe: () => Promise.resolve(SHOWN_ELEMENT),
        screenshot: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])),
        audit: () => Promise.resolve([]),
        accessibilitySnapshot: () => Promise.resolve({ role: "document", name: "", children: [] }),
        blockedOrigins: () => [],
        close: () => Promise.resolve(),
        frame: () => Promise.resolve(success(session)),
        newTab: () => Promise.resolve(success(session)),
        ...changes,
    };
    return session;
}

// A network port that knows only what it has recorded, as the real one does: it has no idea whether
// the page is still alive.
export const fakeNetwork = (exchanges: readonly ObservedExchange[] = []): NetworkPort => ({
    startStub: () => Promise.resolve(success(undefined)),
    stopStub: () => Promise.resolve(success(undefined)),
    stubAnswers: () => [],
    observe: () => Promise.resolve(success(undefined)),
    exchanges: () => exchanges,
    quiet: () => Promise.resolve(success(undefined)),
});

// One finished exchange of the shared project's "likes" request.
export const likesExchange = (status: number, firstName: string): ObservedExchange => ({
    method: "GET",
    url: `${ORIGIN}/api/transactions/likes`,
    status,
    mediaType: "application/json",
    body: new TextEncoder().encode(JSON.stringify({ results: [{ name: firstName }] })),
    stubbed: null,
});

export type FakeRunOptions = {
    readonly session?: Session;
    readonly projectFile?: JsonRecord;
    readonly serviceRoute?: Route;
    readonly commandRoute?: CommandRoute;
};

export type FakeRun = { readonly result: RunResult; readonly audit: MemoryEventSink };

export async function runOnFakeSession(
    raw: unknown,
    options: FakeRunOptions = {},
): Promise<FakeRun> {
    const projectFile = options.projectFile ?? unsafeProjectFile();
    const project = parsedProject(projectFile);
    const parsed = planParser(project)(raw);
    assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
    const trusted = await trustedProjectFrom(projectFile);
    const target = project.matrix[0];
    assert.ok(target !== undefined, "the test project has a target");
    const session = options.session ?? fakeSession();
    const driver: BrowserDriver = {
        info: { id: "cdp", version: "fake", protocol: "none", performs: DRIVER_FEATURES },
        supports: () => success(true),
        open: () => Promise.resolve(success(session)),
    };
    const audit = memoryEventSink();
    const result = await run(
        {
            plan: authorise(parsed.value, trusted),
            project,
            targetId: target.id,
            baseUrl: ORIGIN,
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
            scriptSources: sourceBytes(),
        },
        {
            drivers: new Map([[driver.info.id, driver]]),
            clock: virtualClock(),
            artifacts: memoryArtifactStore(),
            redactor: defaultRedactor(),
            audit,
            events: memoryRunEventSink(),
            secrets: environmentSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
            services: fakeServiceCaller(options.serviceRoute).caller,
            databaseCommands: fakeCommandRunner(options.commandRoute).port,
        },
    );
    return { result, audit };
}

// Every value held under `key` anywhere in the step's result, however the result nests it, so a test
// says what a person must be able to read without fixing where it is kept.
export function recordsNamed(step: StepResult | undefined, key: string): readonly unknown[] {
    assert.ok(step !== undefined, "the step has a result");
    const found: unknown[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value !== "object" || value === null) {
            return;
        }
        for (const [name, nested] of Object.entries(value)) {
            if (name === key) {
                found.push(nested);
            }
            visit(nested);
        }
    };
    visit(JSON.parse(JSON.stringify(step)));
    return found;
}

export const stepSummaries = (
    result: RunResult,
): readonly (readonly [string, string | undefined])[] =>
    result.steps.map((step) => [step.outcome, step.code] as const);
