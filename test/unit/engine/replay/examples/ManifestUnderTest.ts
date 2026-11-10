// Shared setup for the replay engine tests: the run manifest, its perturbations and replay.
//
//   - replay(), decodeManifest(), recordingPorts(), replayedServices() and replayedDatabaseCommands()
//     call the engine's functions, looked up at run time so these tests compile before the functions
//     exist. A missing export fails each test loudly, naming it. What they answer is outside these
//     tests' types, so it is decoded here (replayAnswerOf) before any test reads it;
//   - Scenario is every input of one run, as data, so a test can change exactly one of them.
//     runScenario() runs it on a driver that needs no browser (the recording driver of
//     run-value-examples.ts, with a build port and a reported browser version of the scenario's own),
//     under a virtual clock, with the fake service caller and the fake command runner as its ports;
//   - replayRun() replays a run with fresh ports: a fresh driver that counts its calls, and a live
//     service caller and command runner attached as spies, which a replay must never use.
//
// What these tests assume about shapes the spec leaves open is gathered here, so a change to the
// interface is a change to this file only:
//   - recordingPorts({ services, databaseCommands }) answers the wrapped ports under the same names,
//     each present only when given, and `recording(manifestHash)`, which makes the RunRecording once
//     the run's manifest hash is known;
//   - RunInputs.pins holds RunPins as the build notes list them, and the manifest copies each pin into
//     the field of the same name in the spec's RunManifest block; a host run's pins have no imageDigest;
//   - a replay error is { code } with, for replay-mismatch, `fixture` (the fixture's path), `path`
//     (the JSON path of a known field of the wrong shape) or `kind` and `position` (a recorded reply);
//   - a replay whose inputs all match but whose result hash differs ends with verdict `mismatch`;
//   - a replay is told the state the recorded run ended in, as `recordedState` in its request;
//   - a recording names its schema in a `schema` field, as the manifest does; in it, each reply's
//     entry holds its request's sha256 as the entry's only 64-hex string, and a text body or output
//     is kept as its text, so a test can find and change both.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuaranteeLevel, RunIsolation } from "@revisum/contracts";
import {
    createRunService,
    type RunService,
    HOST_ISOLATION,
    parseProject,
    planParser,
    sha256,
    success,
    type BrowserDriver,
    type ClearedRun,
    type FixtureReference,
    type Plan,
    type Project,
    type RunManifest,
    type RunResult,
    type ServiceRequest,
} from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../../../support/builders/ClearRun.ts";
import {
    DEFAULT_ROUTE,
    fakeCommandRunner,
    type CommandRoute,
    type SeenCommand,
} from "../../run/executors/database-commands/examples/Database.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    ORIGIN,
    accepted,
    recordingDriver,
    type JsonRecord,
} from "../../run/values/examples/RunPlan.ts";
import {
    SHOP_ROUTE,
    routedServiceCaller,
    type Route,
} from "../../run/executors/service-calls/examples/ShopService.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeRunIsolation } from "#test-support/fakes/session/FakeRunIsolation.ts";
import { fakeSecretStore } from "#test-support/fakes/ports/FakeSecretStore.ts";

export { DEFAULT_CLOCK_START, DEFAULT_SEED, ORIGIN, type JsonRecord };

// ---- The types the spec names, as these tests read them --------------------------------------------

// What cli's runPins() gathers and RunInputs.pins carries (build notes, "New fields are optional").
export type RunPins = {
    readonly versions: {
        readonly core: string;
        readonly act: string;
        readonly axe: string;
        readonly node: string;
        readonly packs: readonly string[];
    };
    readonly redactor: string;
    readonly rulesetHash: string;
    readonly baselinesHash: string;
    readonly imageDigest?: string;
    readonly fontsSha256: string;
    readonly commit: string | null;
};

// The manifest fields replay adds, each optional, as the spec's RunManifest block names them. Once
// RunManifest has them, this intersection adds nothing; until then it lets the perturbation table
// name them.
export type PinnedManifestFields = {
    readonly versions?: RunPins["versions"];
    readonly redactor?: string;
    readonly limits?: string;
    readonly baselinesHash?: string;
    readonly rulesetHash?: string;
    readonly executableSha256?: string;
    readonly imageDigest?: string;
    readonly fontsSha256?: string;
    readonly commit?: string | null;
    readonly projectHash?: string;
};
export type ManifestUnderTest = RunManifest & PinnedManifestFields;

export type ReplayOutcome = {
    readonly identical: boolean;
    readonly resultHash: string;
    readonly manifestHash: string;
    readonly differingInputs: readonly string[];
    readonly verdict: string;
};
export type ReplayFailure = {
    readonly code: string;
    readonly fixture?: string;
    readonly path?: string;
    readonly kind?: string;
    readonly position?: number;
};
export type ReplayAnswer =
    | { readonly ok: true; readonly value: ReplayOutcome }
    | { readonly ok: false; readonly error: ReplayFailure };

// The manifest fields whose difference alone makes a replay's verdict per-environment-baseline.
export const PER_ENVIRONMENT_FIELDS = [
    "host",
    "browser",
    "executableSha256",
    "imageDigest",
    "fontsSha256",
    "versions",
] as const;

// ---- Looking up and decoding the engine's functions --------------------------------------------------

export async function engineFunction(
    name: string,
): Promise<(...inputs: readonly unknown[]) => unknown> {
    const loaded: unknown = await import("@revisum/engine");
    const exported: unknown =
        typeof loaded === "object" && loaded !== null
            ? Object.getOwnPropertyDescriptor(loaded, name)?.value
            : undefined;
    if (typeof exported !== "function") {
        throw new Error(`@revisum/engine does not export a function named ${name}`);
    }
    return (...inputs): unknown => Reflect.apply(exported, undefined, inputs);
}

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function replayFailureOf(error: unknown): ReplayFailure {
    assert.ok(
        isRecord(error) && typeof error["code"] === "string",
        `the replay failed without a code: ${JSON.stringify(error)}`,
    );
    const { code, fixture, path, kind, position } = error;
    return {
        code,
        ...(typeof fixture === "string" ? { fixture } : {}),
        ...(typeof path === "string" ? { path } : {}),
        ...(typeof kind === "string" ? { kind } : {}),
        ...(typeof position === "number" ? { position } : {}),
    };
}

export function replayAnswerOf(value: unknown): ReplayAnswer {
    assert.ok(
        isRecord(value) && typeof value["ok"] === "boolean",
        `replay did not answer with a result: ${JSON.stringify(value)}`,
    );
    if (!value["ok"]) {
        return { ok: false, error: replayFailureOf(value["error"]) };
    }
    const outcome = value["value"];
    assert.ok(isRecord(outcome), `replay's outcome is not an object: ${JSON.stringify(value)}`);
    const { identical, resultHash, manifestHash, differingInputs, verdict } = outcome;
    assert.ok(typeof identical === "boolean", "the outcome has no identical flag");
    assert.ok(
        typeof resultHash === "string" && typeof manifestHash === "string",
        "the outcome has no result or manifest hash",
    );
    assert.ok(
        Array.isArray(differingInputs) &&
            differingInputs.every((input) => typeof input === "string"),
        "differingInputs is not a list of names",
    );
    assert.ok(typeof verdict === "string", "the outcome has no verdict");
    return {
        ok: true,
        value: {
            identical,
            resultHash,
            manifestHash,
            differingInputs: [...differingInputs].map(String),
            verdict,
        },
    };
}

// The outcome of a replay that must have succeeded.
export function replayed(answer: ReplayAnswer): ReplayOutcome {
    if (!answer.ok) {
        assert.fail(`the replay failed: ${JSON.stringify(answer.error)}`);
    }
    return answer.value;
}

// The error of a replay that must have failed.
export function refused(answer: ReplayAnswer): ReplayFailure {
    if (answer.ok) {
        assert.fail(`the replay was not refused: ${JSON.stringify(answer.value)}`);
    }
    return answer.error;
}

// decodeManifest(input) as a result: the manifest, or the error's code and path.
export async function decodeManifest(
    input: unknown,
): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: ReplayFailure }
> {
    const decode = await engineFunction("decodeManifest");
    const answer = decode(input);
    assert.ok(
        isRecord(answer) && typeof answer["ok"] === "boolean",
        `decodeManifest did not answer with a result: ${JSON.stringify(answer)}`,
    );
    return answer["ok"]
        ? { ok: true, value: answer["value"] }
        : { ok: false, error: replayFailureOf(answer["error"]) };
}

// ---- Fake browser executables -------------------------------------------------------------------------

const executableFolders: string[] = [];
const executables = new Map<string, string>();

// A browser executable that is only a file of the given text: hashing it is real, and nothing runs it.
// One file per text, made once.
export function fakeExecutable(text: string): string {
    const known = executables.get(text);
    if (known !== undefined) {
        return known;
    }
    const folder = mkdtempSync(join(tmpdir(), "revisum-replay-executable-"));
    executableFolders.push(folder);
    const path = join(folder, "browser-executable");
    writeFileSync(path, text, "utf8");
    executables.set(text, path);
    return path;
}

// Removes every fake executable; each test file calls it after its tests.
export function removeFakeExecutables(): void {
    for (const folder of executableFolders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
    executables.clear();
}

// ---- A scenario: every input of one run ------------------------------------------------------------------

export type FixtureFile = { readonly path: string; readonly text: string };

export type Scenario = {
    readonly projectFile: JsonRecord;
    readonly plan: JsonRecord;
    readonly seed: number;
    readonly clockStartMilliseconds: number;
    readonly fixtures: readonly FixtureFile[];
    readonly host: { readonly platform: string; readonly arch: string };
    readonly baseUrl: string;
    // The secret store's environment.
    readonly environment: Readonly<Record<string, string>>;
    // The page scripts' sources, by declared file.
    readonly scriptSources: Readonly<Record<string, string>>;
    // What the driver says of itself and the browser it opens.
    readonly adapterVersion: string;
    readonly cannotPin: readonly string[];
    readonly browserVersion: string;
    // The text of the executable the driver's build port names, and the version it reports; null
    // when the driver has no build port.
    readonly executable: string | null;
    readonly reportedBuildVersion: string;
    // A path the build port names in place of the executable's own, such as one with no file.
    readonly executablePath?: string;
    readonly pins: RunPins | null;
    readonly serviceRoute: Route;
    readonly commandRoute: CommandRoute;
    // The level the run's isolation port says the runner gave it; the host's own isolation when absent.
    readonly guaranteeLevel?: GuaranteeLevel;
};

export const fixtureReferences = (fixtures: readonly FixtureFile[]): FixtureReference[] =>
    fixtures.map((fixture) => ({ path: fixture.path, sha256: sha256(fixture.text) }));

export const FIXTURE_FILES: readonly FixtureFile[] = [
    {
        path: "/index.html",
        text: '<!doctype html><title>Orders</title><main data-testid="status">Ready</main>\n',
    },
    { path: "/app.js", text: 'document.title = "Orders";\n' },
];

export const PINS: RunPins = {
    versions: {
        core: "0.1.0",
        act: "act-rules-2026.10",
        axe: "4.11.0",
        node: "v24.19.0",
        packs: [],
    },
    redactor: sha256("pii patterns and mask selectors"),
    rulesetHash: sha256("rule ids and probe settings"),
    baselinesHash: sha256("[]"),
    imageDigest: `sha256:${"ab".repeat(32)}`,
    fontsSha256: sha256("system fonts"),
    commit: "0123456789abcdef0123456789abcdef01234567",
};

// A closed plan on the run-value examples' project, with no calls and no commands.
export const closedScenario = (projectFile: JsonRecord, plan: JsonRecord): Scenario => ({
    projectFile,
    plan,
    seed: DEFAULT_SEED,
    clockStartMilliseconds: DEFAULT_CLOCK_START,
    fixtures: FIXTURE_FILES,
    host: { platform: "test", arch: "test" },
    baseUrl: ORIGIN,
    environment: {},
    scriptSources: {},
    adapterVersion: "recording",
    cannotPin: [],
    browserVersion: "1.0",
    executable: null,
    reportedBuildVersion: "1.0",
    pins: null,
    serviceRoute: SHOP_ROUTE,
    commandRoute: DEFAULT_ROUTE,
});

// ---- The driver ----------------------------------------------------------------------------------------

export type DriverCalls = { readonly order: string[] };

// The recording driver, saying of itself what the scenario says, with a build port when the scenario
// names an executable. Every call is noted in order.
export function scenarioDriver(scenario: Scenario): {
    readonly driver: BrowserDriver;
    readonly calls: DriverCalls;
} {
    const { driver: inner } = recordingDriver();
    const calls: DriverCalls = { order: [] };
    const executable = scenario.executable;
    const driver: BrowserDriver = {
        info: {
            id: inner.info.id,
            version: scenario.adapterVersion,
            protocol: inner.info.protocol,
            ...(scenario.cannotPin.length === 0 ? {} : { cannotPin: [...scenario.cannotPin] }),
        },
        supports: (target) => {
            calls.order.push("supports");
            return inner.supports(target);
        },
        open: async (target, environment) => {
            calls.order.push("open");
            const opened = await inner.open(target, environment);
            return opened.ok
                ? success({
                      ...opened.value,
                      browser: { name: "recording-browser", version: scenario.browserVersion },
                  })
                : opened;
        },
        ...(executable === null
            ? {}
            : {
                  build: () => {
                      calls.order.push("build");
                      return Promise.resolve(
                          success({
                              version: scenario.reportedBuildVersion,
                              executablePath: scenario.executablePath ?? fakeExecutable(executable),
                          }),
                      );
                  },
              }),
    };
    return { driver, calls };
}

// ---- Running a scenario ----------------------------------------------------------------------------------

export type ScenarioRun = {
    readonly scenario: Scenario;
    readonly project: Project;
    readonly plan: Plan;
    readonly result: RunResult;
    readonly manifest: ManifestUnderTest;
    // The run's recording when it was recorded through recordingPorts, as JSON; null otherwise.
    readonly recording: unknown;
    readonly serviceRequests: readonly ServiceRequest[];
    readonly commands: readonly SeenCommand[];
    readonly driverCalls: DriverCalls;
};

const scriptBytes = (sources: Readonly<Record<string, string>>): Record<string, Uint8Array> =>
    Object.fromEntries(
        Object.entries(sources).map(([file, text]) => [file, new TextEncoder().encode(text)]),
    );

export function parsedProject(projectFile: JsonRecord): Project {
    const parsed = parseProject(projectFile);
    if (!parsed.ok) {
        throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.value;
}

// The run's inputs a replay is given: everything but the seed, the clock start and the fixtures,
// which come from the manifest.
async function replayInputs(scenario: Scenario): Promise<{
    readonly project: Project;
    readonly plan: Plan;
    readonly cleared: ClearedRun;
    readonly inputs: Readonly<Record<string, unknown>>;
}> {
    const project = parsedProject(scenario.projectFile);
    const plan = accepted(planParser(project), scenario.plan);
    const trusted = await trustedProjectFrom(scenario.projectFile);
    const cleared = clearRun(plan, trusted, project.matrix[0]?.id ?? assert.fail("no target"));
    const inputs = {
        baseUrl: baseUrlOf(scenario.baseUrl),
        host: scenario.host,
        scriptSources: scriptBytes(scenario.scriptSources),
        ...(scenario.pins === null ? {} : { pins: scenario.pins }),
    };
    return { project, plan, cleared, inputs };
}

// The isolation port the scenario's run is handed.
const isolationOf = (scenario: Scenario): RunIsolation =>
    scenario.guaranteeLevel === undefined
        ? HOST_ISOLATION
        : fakeRunIsolation(scenario.guaranteeLevel);

// The wrapped ports and the recording maker recordingPorts gives; see the assumptions at the top.
async function recordedPorts(ports: Readonly<Record<string, unknown>>): Promise<{
    readonly ports: Readonly<Record<string, unknown>>;
    readonly recording: (manifestHash: string | null) => unknown;
}> {
    const wrap = await engineFunction("recordingPorts");
    const wrapped = wrap(ports);
    assert.ok(
        isRecord(wrapped),
        `recordingPorts did not answer with an object: ${JSON.stringify(wrapped)}`,
    );
    const make = wrapped["recording"];
    assert.ok(typeof make === "function", "recordingPorts gave no recording function");
    const kept = Object.fromEntries(
        ["services", "databaseCommands"].flatMap((name) =>
            wrapped[name] === undefined ? [] : [[name, wrapped[name]]],
        ),
    );
    return {
        ports: kept,
        recording: (manifestHash): unknown =>
            JSON.parse(JSON.stringify(Reflect.apply(make, wrapped, [manifestHash]))),
    };
}

// Runs the scenario. With `record`, its service and command ports are wrapped by recordingPorts, as
// cli wraps them for a project that sets replay.recordReplies, and the recording is kept.
export async function runScenario(
    scenario: Scenario,
    options: { readonly record?: boolean } = {},
): Promise<ScenarioRun> {
    const { project, plan, cleared, inputs } = await replayInputs(scenario);
    const { driver, calls } = scenarioDriver(scenario);
    const { caller, requests } = routedServiceCaller(scenario.serviceRoute);
    const { port, commands } = fakeCommandRunner(scenario.commandRoute);
    const live = { services: caller, databaseCommands: port };
    const recorder = options.record === true ? await recordedPorts(live) : null;
    const ports = {
        ...fakePorts({
            drivers: driversOf(driver),
            secrets: fakeSecretStore(scenario.environment),
            isolation: isolationOf(scenario),
        }),
        ...(recorder === null ? live : recorder.ports),
    };
    const runInputs = {
        ...inputs,
        seed: scenario.seed,
        fixedTimeMilliseconds: scenario.clockStartMilliseconds,
        fixtures: fixtureReferences(scenario.fixtures),
    };
    // Built as values, not literals: until the code exists, pins and the wrapped ports are outside
    // the run's types, and an excess field is simply ignored.
    const service: RunService = Reflect.apply(createRunService, undefined, [ports]);
    const result = await (Reflect.apply(Reflect.get(service, "run"), service, [
        cleared,
        runInputs,
    ]) as Promise<RunResult>);
    const manifest: ManifestUnderTest | null = result.manifest;
    assert.ok(manifest !== null, `the run made no manifest: ${JSON.stringify(result)}`);
    return {
        scenario,
        project,
        plan,
        result,
        manifest,
        recording: recorder === null ? null : recorder.recording(result.manifestHash),
        serviceRequests: requests,
        commands,
        driverCalls: calls,
    };
}

// ---- Replaying a run -------------------------------------------------------------------------------------

export type ReplayOptions = {
    // What the replay is given in place of the run's own: its manifest (as JSON), recording and
    // recorded result hash, the host it runs on, and the fixtures it reads.
    readonly manifest?: unknown;
    readonly recording?: unknown;
    readonly recordedResultHash?: string;
    readonly host?: { readonly platform: string; readonly arch: string };
    readonly readFixture?: (path: string) => Uint8Array | null;
    // A scenario to take the replay's own inputs and ports from, such as one with a changed plan.
    readonly scenario?: Scenario;
};

export type Replay = {
    readonly answer: ReplayAnswer;
    readonly driverCalls: DriverCalls;
    // What the live caller and command runner attached to the replay's ports were handed: nothing,
    // whatever happens.
    readonly liveServiceRequests: readonly ServiceRequest[];
    readonly liveCommands: readonly SeenCommand[];
};

export async function replayRun(ran: ScenarioRun, options: ReplayOptions = {}): Promise<Replay> {
    const scenario = options.scenario ?? ran.scenario;
    const { cleared, inputs } = await replayInputs(scenario);
    const { driver, calls } = scenarioDriver(scenario);
    const spyCaller = routedServiceCaller(scenario.serviceRoute);
    const spyRunner = fakeCommandRunner(scenario.commandRoute);
    const fixtureFiles = new Map(
        scenario.fixtures.map((fixture) => [fixture.path, new TextEncoder().encode(fixture.text)]),
    );
    const ports = {
        ...fakePorts({
            drivers: driversOf(driver),
            secrets: fakeSecretStore(scenario.environment),
            isolation: isolationOf(scenario),
        }),
        fixtures: {
            read: async (path: string) =>
                options.readFixture === undefined
                    ? (fixtureFiles.get(path) ?? null)
                    : options.readFixture(path),
        },
        // Not part of ReplayPorts: a replay that used either would send a call or run a command.
        services: spyCaller.caller,
        databaseCommands: spyRunner.port,
    };
    const request = {
        // Only a missing option means the run's own manifest: a test may pass null on purpose.
        manifest:
            "manifest" in options
                ? options.manifest
                : (JSON.parse(JSON.stringify(ran.manifest)) as unknown),
        recording: options.recording === undefined ? ran.recording : options.recording,
        recordedResultHash: options.recordedResultHash ?? ran.result.resultHash,
        recordedState: ran.result.state,
        cleared,
        inputs: options.host === undefined ? inputs : { ...inputs, host: options.host },
    };
    const replay = await engineFunction("replay");
    const answer = replayAnswerOf(await replay(request, ports));
    return {
        answer,
        driverCalls: calls,
        liveServiceRequests: spyCaller.requests,
        liveCommands: spyRunner.commands,
    };
}

// ---- Reading and changing a recording ----------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Every 64-hex string anywhere inside `value`, with a setter for each.
function hexStringsIn(value: unknown): { readonly text: string; set(next: string): void }[] {
    const found: { readonly text: string; set(next: string): void }[] = [];
    const visit = (holder: unknown): void => {
        if (Array.isArray(holder)) {
            holder.forEach((item: unknown, index) => {
                if (typeof item === "string" && SHA256_HEX.test(item)) {
                    found.push({
                        text: item,
                        set: (next) => {
                            holder[index] = next;
                        },
                    });
                } else {
                    visit(item);
                }
            });
        } else if (isRecord(holder)) {
            const fields: Record<string, unknown> = Object.fromEntries(Object.entries(holder));
            for (const [key, item] of Object.entries(fields)) {
                if (typeof item === "string" && SHA256_HEX.test(item)) {
                    found.push({
                        text: item,
                        set: (next) => {
                            Reflect.set(holder, key, next);
                        },
                    });
                } else {
                    visit(item);
                }
            }
        }
    };
    visit(value);
    return found;
}

// The one list in the recording with `length` entries, each an object holding exactly one 64-hex
// string (its request's sha256): the replies of one port, in order.
export function replyListOf(recording: unknown, length: number): unknown[] {
    const lists: unknown[][] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            if (
                value.length === length &&
                value.every((entry: unknown) => isRecord(entry) && hexStringsIn(entry).length === 1)
            ) {
                lists.push(value);
            }
            value.forEach(visit);
        } else if (isRecord(value)) {
            Object.values(value).forEach(visit);
        }
    };
    visit(recording);
    assert.equal(
        lists.length,
        1,
        `expected one list of ${length} recorded replies in ${JSON.stringify(recording)}`,
    );
    return lists[0] ?? [];
}

// A deep copy of the recording, changed by `change`.
export function changedRecording(recording: unknown, change: (copy: unknown) => void): unknown {
    const copy: unknown = JSON.parse(JSON.stringify(recording));
    change(copy);
    return copy;
}

// Changes the request sha256 of the reply at `position` in the list of `length` replies.
export const withRequestHashChanged = (
    recording: unknown,
    length: number,
    position: number,
): unknown =>
    changedRecording(recording, (copy) => {
        const entry = replyListOf(copy, length)[position];
        const [hash] = hexStringsIn(entry);
        assert.ok(hash !== undefined, `reply ${position} has no request sha256`);
        hash.set(sha256(`not the request: ${hash.text}`));
    });

// Removes the last of `length` replies.
export const withLastReplyRemoved = (recording: unknown, length: number): unknown =>
    changedRecording(recording, (copy) => {
        replyListOf(copy, length).pop();
    });

// Adds a copy of the last of `length` replies, which no request will use.
export const withExtraReply = (recording: unknown, length: number): unknown =>
    changedRecording(recording, (copy) => {
        const list = replyListOf(copy, length);
        list.push(JSON.parse(JSON.stringify(list[list.length - 1])));
    });

// The recording's JSON with every `from` replaced by `to`, such as a word of a recorded body.
export function withTextReplaced(recording: unknown, from: string, to: string): unknown {
    const text = JSON.stringify(recording);
    assert.ok(text.includes(from), `the recording does not hold "${from}"`);
    return JSON.parse(text.split(from).join(to));
}

// The recording with one more top-level field, or with its schema replaced.
export const withRecordingField = (recording: unknown, name: string, value: unknown): unknown =>
    changedRecording(recording, (copy) => {
        assert.ok(isRecord(copy), "the recording is not an object");
        Reflect.set(copy, name, value);
    });
