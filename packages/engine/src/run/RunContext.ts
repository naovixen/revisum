// What a cleared run is given, and what its steps run with once preflight has passed.
import type {
    AppliedRewrite,
    ArtifactStore,
    BaseUrl,
    BrowserDriver,
    Clock,
    DatabaseCommandRunner,
    DownloadedFile,
    DownloadName,
    EventSink,
    LockEntry,
    Redactor,
    ResolvedLocator,
    RunIsolation,
    SecretStore,
    ServiceCaller,
    StubName,
} from "@revisum/contracts";
import type { DatabaseCommandContext } from "../database-commands/database-command-steps.ts";
import type { Logger, RunEventSink } from "../logging.ts";
import type { FixtureReference, HostInfo, RunPins } from "../manifest.ts";
import type { NamedScripts } from "../page-scripts/NamedScriptSources.ts";
import type { ClearedRun } from "../policy/ClearedRun.ts";
import type { PolicyGate } from "../policy/policy-gate.ts";
import type { RememberedValues } from "../RememberedValues.ts";
import type { RunStep } from "../RunStep.ts";
import type { RunValues } from "../run-values.ts";
import type { ResolvedSecrets } from "../secrets/secret-resolution.ts";
import type { CallStepContext } from "../service-calls/call-steps.ts";

// How a cleared run is to be run. What it runs, under which project, on which target and as which
// standing are the ClearedRun's alone.
export type RunInputs = {
    readonly baseUrl: BaseUrl;
    readonly seed: number;
    readonly fixedTimeMilliseconds: number;
    readonly fixtures: readonly FixtureReference[];
    readonly host: HostInfo;
    // The sources of the page scripts the project declares, keyed by each declared file path, as the
    // protected branch holds them. The manifest records the sha256 of each one the plan names, so a
    // plan that names a script whose source is not here is refused before any side effect.
    readonly scriptSources?: Readonly<Record<string, Uint8Array>>;
    // The lockfile's entries (readLockfile). Given, the target's browser build is hashed before any
    // browser opens, and a build other than the pinned one ends the run TargetUnavailable with
    // build-mismatch. Absent, no build is checked and nothing is recorded about pinning.
    readonly lockEntries?: readonly LockEntry[];
    // What cli's runPins() gathered about the machine and repository the run starts on: versions,
    // hashes of the redactor, rule set, baselines and fonts, the run image and the commit. Given, the
    // manifest records each, with the project's hash and limits; absent, it records none of them.
    readonly pins?: RunPins;
};

export type RunPorts = {
    readonly drivers: ReadonlyMap<string, BrowserDriver>;
    readonly clock: Clock;
    readonly artifacts: ArtifactStore;
    readonly redactor: Redactor;
    readonly events: RunEventSink;
    // The audit sink that policy denials are appended to. Required, so no run can deny a plan
    // without a record; a denial the sink fails to record is marked unrecorded in the outcome.
    readonly audit: EventSink;
    // How strongly the run is isolated, read as the result is sealed: an isolated runner's handle, or
    // one that always says host. Only 'isolated' makes the result state that egress was enforced. The
    // manifest does not record it, so a replay of an isolated run must be given an isolated one too,
    // or its result hash differs and the replay is a mismatch.
    readonly isolation: RunIsolation;
    // Where the secrets the plan names are resolved, such as environmentSecretStore(process.env).
    // Without one, every secret reference is missing and such a plan is refused.
    readonly secrets?: SecretStore;
    // Sends the requests of the plan's declared calls: runner's caller, through the egress proxy.
    // Without one, a plan that calls a service is refused before any side effect.
    readonly services?: ServiceCaller;
    // Runs the plan's database commands, each in a workload container: cli's wiring of runner's
    // workload runner. Without one, a plan with a database command, cleanup included, is refused
    // before any side effect.
    readonly databaseCommands?: DatabaseCommandRunner;
    // The browser mutants' rewrites the egress proxy applied (EgressProxy.rewritesApplied). Only the
    // proxy knows, and only once the steps have run, so the run reads it after them.
    readonly rewritesApplied?: () => readonly AppliedRewrite[];
};

export type RunContext = {
    readonly cleared: ClearedRun;
    readonly inputs: RunInputs;
    readonly ports: RunPorts;
    readonly logger: Logger;
    readonly gate: PolicyGate;
    // The caller's redactor with the plan's secrets added: every kept text goes through it.
    readonly redactor: Redactor;
    readonly secrets: ResolvedSecrets;
    // The plan's steps as the run runs them, each fill of a secret carrying its own.
    readonly planSteps: readonly RunStep[];
    // Every page script the plan names, with its source.
    readonly scripts: NamedScripts;
    // Whether a whole observed text is a secret too short to search for by value.
    readonly isShortSecret: (observed: string) => boolean;
    // Removes every echo of the plan's secrets, and nothing else, from text as the page wrote it.
    readonly withoutSecrets: (text: string) => string;
    // True when text holds one of the plan's secrets, in any form.
    readonly holdsSecret: (text: string) => boolean;
    // The fields, by their resolved locator as canonical JSON, whose last fill typed a secret. What a
    // check reads back from one is the secret, whatever its length, so it is never kept; a remember
    // step may not read one; and a capture masks each.
    readonly secretFilledFields: Map<string, ResolvedLocator>;
    // The run's values by name: the plan's generated values, the response fields calls remember and
    // the page texts remember steps read.
    readonly values: RunValues;
    // The only way a step adds to the run's values.
    readonly remembered: RememberedValues;
    // The texts remember steps read from the page, which a failed check's observation never keeps.
    readonly rememberedTexts: Set<string>;
    // The files download steps saved, by the name the plan gives each, for later checks. The bytes
    // stay in memory for the run only.
    readonly downloads: Map<DownloadName, DownloadedFile>;
    // What the call steps use: the run's service caller whenever the plan calls a service.
    readonly calls: CallStepContext;
    // What the database steps use: the run's command runner whenever the plan runs a command.
    readonly commands: DatabaseCommandContext;
    // The stubs started and not yet stopped.
    readonly activeStubs: Set<StubName>;
    // True when the target's adapter cannot pin the clock, the time zone or randomness, so the run
    // loses replay-identical. Known from the target alone, before anything runs.
    readonly determinismUnpinned: boolean;
};
