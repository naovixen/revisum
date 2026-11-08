// Compile-time guarantees around what the composition root hands out. Type-checked by
// CompositionRootTypeGuarantees.test.ts, never run. Each @ts-expect-error line must stay an error.
import {
    buildAdapters,
    type BenchmarkPorts,
    type ContainerCrawlPorts,
    type DraftCommandPorts,
    type LoginRunner,
    type PlannerCall,
} from "@revisum/cli";
import { launchChromium, type EgressSource, type SessionEgress } from "@revisum/driver-cdp";
import type {
    BrowserDriver,
    ClearedRun,
    EventSink,
    Redactor,
    Result,
    RunInputs,
    SecretName,
    SecretStore,
    Session,
    VersionControlPort,
    WorkloadRunner,
} from "@revisum/engine";

declare const browser: BrowserDriver;
declare const login: ClearedRun;
declare const loginOnItsSession: Parameters<LoginRunner>[0];
declare const sessionOpenedElsewhere: Session;
declare const inputs: RunInputs;
declare const redactor: Redactor;
declare const secrets: SecretStore;
declare const audit: EventSink;
declare const events: EventSink;
declare const versionControl: VersionControlPort;
declare const planner: PlannerCall;
declare const workload: WorkloadRunner;
declare const secretNames: readonly SecretName[];
declare const bareEgress: SessionEgress;

const draftNeeds = { workingDirectory: "project", secrets, events, versionControl, planner };
const suiteNeeds = {
    workload,
    secrets,
    checkout: "checkout",
    outputDirectory: "output",
    pass: "gating",
} as const;

const crawlPorts: Result<ContainerCrawlPorts, string> = buildAdapters.containerCrawlPorts({
    executablePath: "chrome",
    secretNames,
    environment: {},
});

export const compositionRootTypeGuarantees = {
    isolatedLaunch: launchChromium("chrome", { profilePrefix: "scan-" }),
    loginRuns: buildAdapters.loginRunner(loginOnItsSession, inputs),
    draftPorts: buildAdapters.draftCommandPorts(draftNeeds),
    draftPortsWithAnOverride: buildAdapters.draftCommandPorts(draftNeeds, { redactor, browser }),
    suitePorts: buildAdapters.suiteRunPorts(suiteNeeds),
    suitePortsWithAnOverride: buildAdapters.suiteRunPorts(suiteNeeds, { redactor }),
    crawlPorts,
};

export const isBrowserRequired: Pick<DraftCommandPorts, "browser"> extends Required<
    Pick<DraftCommandPorts, "browser">
>
    ? true
    : false = true;

export const isIsolatedRunnerRequired: Pick<DraftCommandPorts, "isolatedRunner"> extends Required<
    Pick<DraftCommandPorts, "isolatedRunner">
>
    ? true
    : false = true;

export const startsWithFlags = launchChromium("chrome", {
    // @ts-expect-error the production launcher takes no flags of the caller's
    arguments: ["--no-sandbox"],
});

export const handBuiltLogin = buildAdapters.loginRunner(
    // @ts-expect-error a login and a session are put together only where the crawl opens the session
    { login, session: sessionOpenedElsewhere, browser, redactor, secrets, audit },
    inputs,
);

export const loginMovedToAnotherSession = buildAdapters.loginRunner(
    // @ts-expect-error a login cannot be moved to a session opened elsewhere
    { ...loginOnItsSession, session: sessionOpenedElsewhere },
    inputs,
);

export const draftPortsTakeNoRedactorAmongTheirNeeds = buildAdapters.draftCommandPorts({
    workingDirectory: "project",
    secrets,
    events,
    versionControl,
    planner,
    // @ts-expect-error a weaker redactor can only be an explicit override
    redactor,
});

export const suitePortsTakeNoRedactorAmongTheirNeeds = buildAdapters.suiteRunPorts({
    workload,
    secrets,
    checkout: "checkout",
    outputDirectory: "output",
    pass: "gating",
    // @ts-expect-error a weaker redactor can only be an explicit override
    redactor,
});

// @ts-expect-error a caller that leaves the pass out must not get the pass that may open the merge gate
export const suitePortsWithoutAPass = buildAdapters.suiteRunPorts({
    workload,
    secrets,
    checkout: "checkout",
    outputDirectory: "output",
});

export const crawlPortsTakeNoProxyServer = buildAdapters.containerCrawlPorts({
    executablePath: "chrome",
    secretNames,
    environment: {},
    // @ts-expect-error the ports read HTTP_PROXY themselves, so no caller can skip the check
    proxyServer: "http://127.0.0.1:9",
});

// @ts-expect-error a source says it failed in its answer, so it answers with a Result
export const answersBareEgress: EgressSource = () => Promise.resolve(bareEgress);

// @ts-expect-error what an egress refused may be unknown, which only a Result can say
export const refusedOriginsAsAList: readonly string[] = bareEgress.refusedOrigins();

// @ts-expect-error the benchmark's stand-in protected branch is not handed to anyone outside the cli
export type BenchmarkBranch = BenchmarkPorts["protectedBranchHolding"];
