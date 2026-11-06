// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports; page scripts through its script port. Database commands
// go through the run's DatabaseCommandRunner port, which runs each in a workload container.
import {
  failure, FillValueKind, isOneElementRead, NavigateScripts, UnavailableReason, oneElementOf, PageReadFailureCode, stepFailed, StepCode, success, UnreadablePage,
  type A11yFinding, type ActionGuard, type AppliedRewrite, type ApprovalLabel, type ArtifactReference, type ArtifactStore, type BaseUrl,
  type BrowserDriver, type Clock, type DatabaseCommandRunner, type DocumentSession, type DomRead, type DownloadedFile, type DownloadName, type DriverError, type DriverErrorCode, type OneElementRead, type PageReadFailure, type RememberedElementSource, type LockEntry, type DialogStep, type ElementProbe,
  type EventSink, type FillValue, type GuardVerdict, type PageAssertion, type PerformableAction, type PerformableFill, type Plan, type PolicyRuleId, type Redactor, type ResolvedActionStep,
  type ResolvedDialogStep, type ResolvedDownloadStep,
  type DownloadStep, type StepOutcome, type ResolvedElement, type ResolvedLocator, type Result, type RunIsolation, type SafeText, type SecretStore, type SecretName, type ServiceCaller, type Session, type Step, type Target,
  type Unavailable, type ValueName, type GuaranteeStatement, type RunMode, type SuiteFinding, type SuiteName, type SuitePass,
  type StubAnswer, type StubName, type SuiteTestId, type SuiteTestResult, type UnsafeFeature,
} from '@revisum/contracts';
import { approvalLabel, type PlanStanding } from './approval/plan-standing.ts';
import { totalClockAdvanceMilliseconds } from './clock-advance.ts';
import {
  COMMAND_ERROR_CODES, runDatabaseCheck, runDatabaseStep, type DatabaseCommandContext, type DatabaseCommandRecord,
} from './database-commands/database-command-steps.ts';
import { advanceClock, checkClipboard, rememberFromClipboard, type ClockAndClipboardContext } from './clock-and-clipboard-steps.ts';
import { guaranteeStatement } from './guarantees.ts';
import { canonicalJson, sha256 } from './hashing.ts';
import * as lifecycle from './lifecycle.ts';
import { manifestLogger, type Logger, type RunEventSink } from './logging.ts';
import {
  checkRequests, checkResponse, checkStorage, observedRequestNames, rememberFromResponse, resetRequests, runStubStep, startObserving, writeStorage,
  type NetworkStepContext,
} from './network-and-storage/network-and-storage-steps.ts';
import {
  DATABASE_COMMANDS_INPUT, DETERMINISM_INPUTS, buildManifest, manifestHash, unsafeFeatureRecord,
  type FixtureReference, type HostInfo, type RunManifest, type RunPins,
} from './manifest.ts';
import { checkElement, checkPage, domReadFor, normalise, type Verdict } from './oracle.ts';
import { refusedResult, targetUnavailableResult } from './NothingRanResult.ts';
import { runEvaluate, runScriptCheck, type PageScriptContext, type PageScriptRecord } from './page-scripts/page-script-steps.ts';
import type { SuiteDecodeError } from './evidence/suite-report.ts';
import type { PlanError } from './plan/plan-decoders.ts';
import { ASSERTION_STEP_TYPES } from './plan/plan-grammar.ts';
import { assertBranded } from './plan/plan-parser.ts';
import { unsafeFeaturesOf } from './plan/unsafe-features.ts';
import { assertCleared, ClearedRunKind, type ClearedRun } from './policy/ClearedRun.ts';
import type { TargetNotDeclared } from './policy/TargetNotDeclared.ts';
import { policyGate, type PolicyGate } from './policy/policy-gate.ts';
import { checkPreflight, type PreflightPassed } from './CheckPreflight.ts';
import { callsServices, runsDatabaseCommands } from './plan/CallsServices.ts';
import { reachableOrigins } from './ReachableOrigins.ts';
import type { Project } from './project/project-parser.ts';
import { declaredCommands } from './project/unsafe-feature-declarations.ts';
import { SENSITIVE_PLACEHOLDER } from './redaction.ts';
import { rememberedValues, type RememberedValues } from './RememberedValues.ts';
import { withRunHashes } from './WithRunHashes.ts';
import {
  generateRunValues, resolveActionStep, resolveElementAssertion, resolveLocator, resolvePathTemplate, resolvePlanClock, resolveText, type RunValues,
} from './run-values.ts';
import {
  NO_SECRETS, commandSecretStore, fillSecretOf, resolvePlanSecrets, resolvedSecretStore, secretEchoRemoval, secretRecords, shortSecretObservation, stubAndStorageSecretStore, withSecretRedaction,
  type ResolvedSecrets,
} from './secrets/secret-resolution.ts';
import { SECRET_PLACEHOLDER } from './secrets/secret-values.ts';
import { adapterRegistry } from './target/adapter-registry.ts';
import { BROWSER_BUILD_INPUT, checkPinnedBuild } from './target/target-lock.ts';
import {
  NO_ANSWER_CODES, runBackendCheck, runCallStep, runCleanup, type CallStepContext, type CleanupResult, type ServiceCallRecord,
} from './service-calls/call-steps.ts';

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

export type StepResult = {
  readonly index: number;
  readonly type: Step['type'];
  readonly outcome: StepOutcome;
  readonly code?: StepCode;
  // A redacted observation, kept only when a step fails.
  readonly observed?: string;
  readonly artifact?: ArtifactReference;
  readonly findings?: readonly A11yFinding[];
  // A call or backend check's record: status and response sha256, never a header or the body.
  readonly serviceCall?: ServiceCallRecord;
  // A remember step's record: the value's name and the sha256 of its text, never the text. An
  // evaluate that remembers one value records it here too; one that remembers several records
  // them in rememberedValues.
  readonly remembered?: RememberedValueRecord;
  readonly rememberedValues?: readonly RememberedValueRecord[];
  // A page-script step's record: the script, how often it ran and its result's sha256, never the result.
  readonly pageScript?: PageScriptRecord;
  // A database step's record: the command, its service, exit code and output sha256, never the output.
  readonly databaseCommand?: DatabaseCommandRecord;
  // A download step's record: the file's name, media type, size and sha256, never its content.
  readonly download?: DownloadRecord;
  // An assertion's record of the stubs active while it ran, sorted by name, so a report can say it
  // checked a faked answer and not the real backend. Absent when no stub was active.
  readonly activeStubs?: readonly StubName[];
  // A frame or newTab step's record of the passed steps inside it that left a record of their own,
  // in order, each under the frame or newTab step's index. Absent when none did, so a frame of
  // plain actions and checks keeps its result, and its hash, exactly as they were. The step that
  // failed a frame or newTab step is not here: its code and records are the frame or newTab step's.
  readonly innerSteps?: readonly StepResult[];
};

export type RememberedValueRecord = { readonly valueName: ValueName; readonly sha256: string };
// What a run keeps of a downloaded file. The server's name and media type are kept redacted; the
// content is never kept (until privacy masking, whatever evidence.keepDownloads says).
export type DownloadRecord = {
  readonly downloadName: DownloadName;
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
};

// Something a run found that a person should look at, whatever the verdict: a cleanup call that
// failed, so test data may be left behind; or a suite test's criterion annotation whose
// description is not a valid criterion id, so it was dropped (never echoed).
export type RunReviewItem =
  | { readonly code: 'cleanup-failed'; readonly cleanupIndex: number }
  | { readonly code: 'spec-ambiguous'; readonly testId: SuiteTestId; readonly annotationIndex: number }
  // A test the suite marked as expected to fail did fail: Playwright counts it as expected, but a
  // person should see why a failing test is kept.
  | { readonly code: 'expected-failure'; readonly testId: SuiteTestId }
  // A project the suite declares has no test in the report, so what was tested is less than declared.
  | { readonly code: 'project-without-tests'; readonly project: SafeText }
  // Part of the suite's output was refused (the run's decodeErrors, at this index), so the result
  // shows less than the suite recorded.
  | { readonly code: 'suite-output-unread'; readonly decodeErrorIndex: number }
  // A plan run's egress could not say what it refused, so its empty blockedOrigins claims nothing and
  // the run ended Errored.
  | { readonly code: typeof EGRESS_UNREAD };

// Why an evidence run ended as it did, beyond its tests' outcomes.
//   vacuous: the report holds no test that ran, so the run checked nothing and ends Failed.
//   suite-timeout: the suite ran past its timeout and was stopped; the run ends Errored.
//   setup-failed: the suite's setup command failed or timed out, so the suite never ran; Errored.
//   suite-report-unread: the suite's report is missing or was refused (decodeErrors says why); Errored.
//   egress-unread: what the egress proxy decided could not be read back, or not all of it was written,
//   so the run cannot show its egress was enforced; Errored.
export type EvidenceOutcomeCode = 'vacuous' | 'suite-timeout' | 'setup-failed' | 'suite-report-unread' | 'egress-unread';

// What only an evidence run records: which pass it was, the suite command's exit code, and whether
// that code disagreed with the outcomes the report gives, which makes the run Errored. The outcome
// code and decode errors are present only when there are some, so other results stay as they were.
export type EvidenceRunRecord = {
  readonly pass: SuitePass;
  readonly exitCode: number;
  readonly exitCodeMismatch: boolean;
  readonly outcomeCode?: EvidenceOutcomeCode;
  // Codes and JSON paths only, never a value from the suite's output.
  readonly decodeErrors?: readonly SuiteDecodeError[];
};

// An evidence run's tests, one per test and project, and the findings its failed tests became.
export type SuiteRunRecord = {
  readonly name: SuiteName;
  readonly tests: readonly SuiteTestResult[];
  readonly findings: readonly SuiteFinding[];
  // Present when the recorded pages were audited.
  readonly accessibilityFindings?: readonly A11yFinding[];
};

export type RunResult = {
  readonly state: lifecycle.TerminalState;
  // How the run came about: a parsed plan, or a team's own suite in evidence mode.
  readonly mode: RunMode;
  // Which guarantees hold for this run, and why each lost one is lost.
  readonly guarantees: GuaranteeStatement;
  // The unsafe features the run's plan uses: the run's unsafe label. Present only when there is one,
  // so a closed run's result and its hash stay exactly as they were.
  readonly unsafeFeatures?: readonly UnsafeFeature[];
  // Present for an evidence run.
  readonly suite?: SuiteRunRecord;
  readonly evidence?: EvidenceRunRecord;
  // An evidence run has no plan target: it carries its suite's name.
  readonly targetId: string;
  readonly manifest: RunManifest | null;
  readonly manifestHash: string | null;
  readonly steps: readonly StepResult[];
  readonly blockedOrigins: readonly string[];
  readonly unavailable: Unavailable | null;
  // Present when the run was refused before any driver call.
  readonly refusal?: lifecycle.Refusal;
  // Present when the policy gate's runtime guard stopped the run before an action.
  readonly denial?: lifecycle.Denial;
  // Present when the plan is approved: what the result says about that approval.
  readonly approvalLabel?: ApprovalLabel;
  // Present when the plan has cleanup calls and its steps ran: one record per call, in order.
  readonly cleanup?: readonly CleanupResult[];
  // Present when the run raised something for a person to look at.
  readonly reviewItems?: readonly RunReviewItem[];
  // Present when a stub answered a request: which stub and which of its responses (counted from 1)
  // answered each, in the order they were answered.
  readonly stubAnswers?: readonly StubAnswer[];
  // What replay compares: everything above except the manifest body, which its own hash covers, and
  // blockedOrigins, which a request sent as a run ends can change. Timings are excluded.
  readonly resultHash: string;
  // The same, with blockedOrigins covered, so an edit to that list shows against a copy held elsewhere.
  readonly evidenceHash: string;
  readonly timings: { readonly totalMilliseconds: number; readonly stepMilliseconds: readonly number[] };
};

export type Rejected = { readonly state: 'Rejected'; readonly errors: readonly PlanError[] };
// A parsed plan the policy gate's static check denied, so no run started. `unrecorded` is present
// when the audit sink failed to record the denial.
export type DeniedPlan = { readonly state: 'Denied'; readonly rule: PolicyRuleId; readonly stepIndex: number | null; readonly unrecorded?: true };

// What a result is for, whether or not a run was cleared for its target.
type RunSubject = Pick<TargetNotDeclared, 'plan' | 'project' | 'targetId' | 'standing'>;

type RunContext = {
  readonly cleared: ClearedRun;
  readonly inputs: RunInputs;
  readonly ports: RunPorts;
  readonly logger: Logger;
  readonly gate: PolicyGate;
  // The runtime guard's denial, once it has stopped an action.
  readonly denials: lifecycle.Denial[];
  // The caller's redactor with the plan's secrets added: every kept text goes through it.
  readonly redactor: Redactor;
  readonly secrets: ResolvedSecrets;
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
  // The plan steps whose frame or second tab holds a setup step that failed. A frame or newTab step
  // reports under its own type, so its type alone cannot say the run could not test.
  readonly setupFailedInside: Set<number>;
};

// What a step runs with: the run's context, and the open session whose ports its steps use.
type StepContext = RunContext & { readonly session: Session };

const POLL_INTERVAL_MILLISECONDS = 50;
// Longer than a driver's stop takes to give up by itself, so this deadline is only for what has wedged.
const LONGEST_SESSION_CLOSE_MILLISECONDS = 60_000;

export async function run(cleared: ClearedRun, inputs: RunInputs, ports: RunPorts): Promise<RunResult> {
  // First, before any side effect: a run the gate did not clear, or a plan the parser did not make,
  // is refused, whatever its type says.
  assertCleared(cleared);
  assertBranded(cleared.plan);
  const { plan, project, target } = cleared;
  const startedAt = ports.clock.now();
  const { resolution, redactor, logger } = runLogging(cleared, inputs.seed, ports);
  const nothingRan: NothingRanContext = { cleared, ports, logger, determinismUnpinned: cannotPinDeterminism(ports.drivers, target) };
  const planned = lifecycle.plan(plan, target);
  // A log that fails this early ends the run Errored like one that fails later, once there are steps
  // to account for. It must not reject the run, and a refusal below still stands.
  const isPlanLogged = logKeepingTheResult({ kind: 'run.state', state: planned.state, targetId: target.id }, logger);

  const scriptSources = inputs.scriptSources ?? {};
  const preflight = checkPreflight({
    cleared, baseUrl: inputs.baseUrl, secrets: resolution, scriptSources, services: ports.services, databaseCommands: ports.databaseCommands,
  });
  if (!preflight.ok) {
    return refuseRun(planned, preflight.error, nothingRan, startedAt);
  }
  const context = runContext(cleared, inputs, preflight.value, { ...nothingRan, redactor });
  const unsafe = unsafeFeatureRecord(plan, project, scriptSources);

  const opened = await openSession(planned, context);
  if (!opened.ok) {
    const unavailable = lifecycle.targetUnavailable(planned, opened.error);
    return unavailableResult(target.id, unavailable.unavailable, context, startedAt);
  }
  const { session, driver, executableSha256 } = opened.value;
  // A database command's output, and the database it ran against, cannot be pinned.
  const unpinned = [...opened.value.unpinned, ...(runsDatabaseCommands(plan) ? [DATABASE_COMMANDS_INPUT] : [])];
  const stepContext: StepContext = { ...context, session };
  const manifestInputs: Parameters<typeof buildManifest>[0] = {
    plan, target, adapter: driver.info, browser: session.browser,
    seed: inputs.seed, fixedTimeMilliseconds: inputs.fixedTimeMilliseconds, fixtures: inputs.fixtures, host: inputs.host,
    ...secretRecords(context.secrets), callsServices: callsServices(plan),
    ...(unsafe === undefined ? {} : { unsafe }),
    ...(unpinned.length === 0 ? {} : { unpinned }),
    ...(executableSha256 === undefined ? {} : { executableSha256 }),
    ...(inputs.pins === undefined ? {} : { pins: { pins: inputs.pins, project } }),
    recordsReplies: project.replay?.recordReplies === true,
  };
  const manifestBeforeTheSteps = buildManifest(manifestInputs);
  const resolved = lifecycle.resolve(planned, session, manifestBeforeTheSteps, manifestHash(manifestBeforeTheSteps));
  const running = lifecycle.start(resolved);
  const steps: StepResult[] = [];
  const stepMilliseconds: number[] = [];
  let stubAnswers: readonly StubAnswer[] = [];
  let rewrites: readonly AppliedRewrite[];
  let finished: lifecycle.Finished<'Passed' | 'Failed' | 'Errored'> | lifecycle.DeniedRun;
  try {
    if (!isPlanLogged) {
      throw new Error('the log could not be written');
    }
    // The hash as it stands before the steps: a run whose proxy then rewrites a response ends with another.
    logger.log({ kind: 'run.state', state: resolved.state, targetId: target.id, adapter: driver.info.id, sha256: resolved.manifestHash });
    logger.log({ kind: 'run.state', state: running.state, targetId: target.id });
    const notObserved = await failureToObserveRequests(session, stepContext);
    for (const [index, step] of plan.steps.entries()) {
      if (steps.some((done) => done.outcome === 'failed')) { steps.push({ index, type: step.type, outcome: 'skipped' }); continue; }
      const stepStartedAt = ports.clock.now();
      logger.log({ kind: 'step.start', stepIndex: index, stepType: step.type });
      // The first step stands for what could not be started, so the result says why nothing ran.
      const done = index === 0 && notObserved !== undefined ? failedStep(step, index, notObserved) : await runStep(step, index, session, target, stepContext);
      // With no later step to notice, a crash the last step did not report would go unseen.
      const isLastStep = index === plan.steps.length - 1;
      const result = isLastStep && done.outcome === 'passed' && session.crashed() ? failedStep(step, index, TARGET_CRASHED) : done;
      stepMilliseconds.push(ports.clock.now() - stepStartedAt);
      steps.push(result);
      logger.log({
        kind: 'step.end', stepIndex: index, stepType: step.type, outcome: result.outcome,
        durationMilliseconds: stepMilliseconds[stepMilliseconds.length - 1] ?? 0, ...(result.code === undefined ? {} : { code: result.code }),
      });
    }
    // In the try: a port that cannot say what it rewrote must not leave a mutated run reading as plain.
    rewrites = ports.rewritesApplied?.() ?? [];
    // A denied action failed its step, so every later step was skipped and nothing ran after it.
    // A failed call, page script or database command could not set up or reach what the test
    // needs, and a page script that threw, hung or gave no usable result, or a backend check whose
    // call got no answer, could not check it, which is not a product failure.
    const denial = context.denials[0];
    if (denial !== undefined && steps.some((done) => done.code === 'policy-denied')) {
      finished = lifecycle.deny(running, denial);
    } else if (steps.some((done) => couldNotTest(done, stepContext))) {
      finished = lifecycle.finish(running, 'Errored');
    } else {
      finished = lifecycle.finish(running, steps.every((done) => done.outcome === 'passed') ? 'Passed' : 'Failed');
    }
  } catch {
    // A step's own failures never get here, so only the log or the clock can have failed. The result
    // still accounts for every step.
    const [unfinished, ...unreached] = plan.steps.slice(steps.length);
    if (unfinished !== undefined) {
      steps.push(failedStep(unfinished, steps.length, ADAPTER_ERROR));
    }
    for (const step of unreached) {
      steps.push({ index: steps.length, type: step.type, outcome: 'skipped' });
    }
    finished = lifecycle.finish(running, 'Errored');
    rewrites = readKeepingTheResult(() => ports.rewritesApplied?.() ?? [], [], logger);
  } finally {
    // Read before the browser goes, with every answer the stubs gave.
    stubAnswers = readKeepingTheResult(() => session.network.stubAnswers(), [], logger);
    await closeKeepingTheResult(session, ports.clock, logger);
  }
  // Read once the session has closed, when no decision is left waiting for the browser's answer. With
  // no later step to report one the browser refused after the last step ended, the last step stands
  // for it, as it does for a crash it missed.
  const refusedDecisions: readonly string[] = readKeepingTheResult(() => session.refusedRequestDecisions(), [], logger);
  for (const refusal of refusedDecisions) {
    logFailureAfterTheVerdict(ADAPTER_ERROR, refusal, logger);
  }
  if (refusedDecisions.length > 0 && finished.state === 'Passed') {
    const lastStep = steps.pop();
    if (lastStep !== undefined) {
      steps.push({ ...lastStep, ...stepFailed(ADAPTER_ERROR) });
    }
    finished = lifecycle.finish(running, 'Errored');
  }
  // Whatever the outcome. A failing cleanup step never changes the verdict; it raises a review item.
  const cleanup = plan.cleanup === undefined ? undefined : await runCleanup(plan.cleanup, plan.steps.length, context.calls, context.commands);
  const cleanupItems = (cleanup ?? []).flatMap((done): RunReviewItem[] => (done.outcome === 'failed' ? [{ code: 'cleanup-failed', cleanupIndex: done.index }] : []));
  const blockedRead = readBlockedOrigins(session);
  if (!blockedRead.ok) {
    logFailureAfterTheVerdict(EGRESS_UNREAD, blockedRead.error, logger);
  }
  const blocked = blockedRead.ok ? blockedRead.value : [];
  const reviewItems: readonly RunReviewItem[] = blockedRead.ok ? cleanupItems : [...cleanupItems, { code: EGRESS_UNREAD }];
  const endState = blockedRead.ok ? finished : lifecycle.finish(running, 'Errored');
  readKeepingTheResult(() => {
    for (const { origin, message } of session.connectionFailures()) {
      logger.log({ kind: 'session.connection-failed', origin, detail: message });
    }
  }, undefined, logger);
  readKeepingTheResult(() => {
    for (const origin of blocked) logger.log({ kind: 'network.blocked', origin });
    logger.log({
      kind: 'run.state', state: endState.state, targetId: target.id,
      ...(endState.state === 'Denied' ? { code: endState.denial.rule, stepIndex: endState.denial.stepIndex } : {}),
    });
  }, undefined, logger);
  const manifest = rewrites.length === 0 ? finished.manifest : buildManifest({ ...manifestInputs, responseRewrites: rewrites });
  return seal({
    state: endState.state, targetId: target.id, manifest, manifestHash: manifestHash(manifest),
    steps, blockedOrigins: blocked, unavailable: null, ...(finished.state === 'Denied' ? { denial: finished.denial } : {}),
    ...(cleanup === undefined ? {} : { cleanup }), ...(reviewItems.length === 0 ? {} : { reviewItems }),
    ...(stubAnswers.length === 0 ? {} : { stubAnswers: [...stubAnswers] }),
    timings: { totalMilliseconds: readKeepingTheResult(() => ports.clock.now() - startedAt, 0, logger), stepMilliseconds },
  }, context);
}

// What the run logs and redacts with. Resolving reads only the store, so it comes first: the run's
// redactor needs the secrets before anything is logged. A missing secret refuses the run at
// preflight, before any driver call. A command's secrets are needed only by a run that can run
// commands.
function runLogging(subject: RunSubject, seed: number, ports: RunPorts): {
  readonly resolution: Result<ResolvedSecrets, SecretName>; readonly redactor: Redactor; readonly logger: Logger;
} {
  const { plan, project } = subject;
  const runId = sha256(`${sha256(canonicalJson(plan))}:${subject.targetId}:${seed}`).slice(0, 16);
  const commandDeclarations = ports.databaseCommands === undefined ? {} : declaredCommands(project.unsafeFeatures);
  const resolution = resolvePlanSecrets(plan, ports.secrets, project.calls, commandDeclarations);
  const redactor = withSecretRedaction(ports.redactor, resolution.ok ? resolution.value : NO_SECRETS);
  return { resolution, redactor, logger: manifestLogger(ports.events, redactor, runId) };
}

// The context of a run that passed preflight: what its steps run with.
function runContext(
  cleared: ClearedRun, inputs: RunInputs, passed: PreflightPassed, logging: NothingRanContext & { readonly redactor: Redactor },
): RunContext {
  const { plan, project, target } = cleared;
  const { ports, logger, redactor } = logging;
  const { secrets } = passed;
  // Generation is pure, so values exist before anything runs.
  const values = new Map<ValueName, SafeText>(generateRunValues(plan, inputs.seed, inputs.fixedTimeMilliseconds, target, project));
  const isShortSecret = shortSecretObservation(secrets);
  const withoutSecrets = secretEchoRemoval(secrets);
  const rememberedTexts = new Set<string>();
  const holdsSecret = (text: string): boolean => isShortSecret(text) || withoutSecrets(text) !== text;
  const remembered = rememberedValues({
    values, rememberedTexts, hasSecret: holdsSecret,
    maximumTextLength: project.limits.maximumTextLength, logger,
  });
  const calls: CallStepContext = {
    caller: passed.services, project, values, remembered, secrets: resolvedSecretStore(secrets), clock: ports.clock, logger, holdsSecret,
  };
  const commands: DatabaseCommandContext = {
    runner: passed.databaseCommands, project, values, remembered, secrets: commandSecretStore(secrets), clock: ports.clock, logger, holdsSecret,
  };
  return {
    cleared, inputs, ports, logger, gate: policyGate({ project, events: ports.audit }), denials: [], redactor, secrets, isShortSecret, withoutSecrets,
    holdsSecret, secretFilledFields: new Map(), values, remembered, calls, commands, rememberedTexts, downloads: new Map(), activeStubs: new Set(),
    setupFailedInside: new Set(), determinismUnpinned: logging.determinismUnpinned,
  };
}

// The result of a target the gate gave no cleared run, since the plan or the project's matrix does
// not declare it: TargetUnavailable with not-declared, before any driver is asked. It is logged and
// sealed as any run that never opened its target is.
function targetNotDeclaredResult(notDeclared: TargetNotDeclared, seed: number, ports: RunPorts): RunResult {
  const startedAt = ports.clock.now();
  const { logger } = runLogging(notDeclared, seed, ports);
  const target = notDeclared.project.matrix.find((candidate) => candidate.id === notDeclared.targetId);
  const nothingRan: NothingRanContext = {
    cleared: notDeclared, ports, logger, determinismUnpinned: target !== undefined && cannotPinDeterminism(ports.drivers, target),
  };
  const unavailable = { reason: UnavailableReason.NotDeclared, detail: 'target is not in both the plan and the matrix' };
  return unavailableResult(notDeclared.targetId, unavailable, nothingRan, startedAt);
}

// The only entry point for untrusted input, such as a plan an AI proposed. Parsing happens first,
// then the policy gate's static check against the project, for the plan's declared targets and
// standing; on any error or denial no driver method is called. A missing standing, or one whose
// approval is for another plan's hash, is a proposal: it never reaches the project's production
// origins.
export async function runUntrusted(
  input: unknown,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
  base: RunInputs & { readonly project: Project; readonly standing?: PlanStanding },
  ports: RunPorts,
): Promise<Rejected | DeniedPlan | readonly RunResult[]> {
  const parsed = parsePlan(input);
  if (!parsed.ok) return { state: 'Rejected', errors: parsed.error };
  const { project, standing, ...inputs } = base;
  const gate = policyGate({ project, events: ports.audit });
  // One result per target the plan names, in its order: one the matrix does not declare ends
  // TargetUnavailable with not-declared.
  const decision = gate.decide(parsed.value, parsed.value.targets, standing);
  if (decision.kind === 'deny') {
    return { state: 'Denied', rule: decision.rule, stepIndex: decision.stepIndex, ...(decision.unrecorded ? { unrecorded: true } : {}) };
  }
  const results: RunResult[] = [];
  for (const clearance of decision.runs) {
    switch (clearance.kind) {
      case ClearedRunKind: results.push(await run(clearance, inputs, ports)); break;
      case UnavailableReason.NotDeclared: results.push(targetNotDeclaredResult(clearance, inputs.seed, ports)); break;
    }
  }
  return results;
}

// The steps that set up or reach what the test needs: when one fails, the run could not test.
const SETUP_STEP_TYPES: readonly Step['type'][] = ['call', 'evaluate', 'database'];
// A step the adapter threw on, or that a refused request decision spoilt: what it saw is unknown,
// which is not a product failure either. The code stands for the failure and its text stays out of
// the result, since it could hold page content or a secret.
const ADAPTER_ERROR = StepCode.AdapterError;
// The codes of a page script or a database command that could not give a result to check, in
// whatever step it ran, of a service call that got no answer, and of an adapter that threw: the run
// could not test, which is not a product failure.
const UNUSABLE_RESULT_CODES: readonly string[] = [
  'script-failed', 'script-timeout', 'script-result-invalid', 'script-result-too-large', ADAPTER_ERROR, ...COMMAND_ERROR_CODES, ...NO_ANSWER_CODES,
];

// True when a failed step means the run could not test, wherever in the plan the step stands.
const couldNotTest = (done: StepResult, context: RunContext): boolean =>
  done.outcome === 'failed' && (SETUP_STEP_TYPES.includes(done.type) || UNUSABLE_RESULT_CODES.includes(done.code ?? '') || context.setupFailedInside.has(done.index));

// What the event log says of a refusal beyond its code.
function loggedWithRefusal(refusal: lifecycle.Refusal): { readonly origin?: string; readonly detail?: string } {
  switch (refusal.code) {
    case 'origin-not-allowed': return { origin: refusal.origin };
    case 'secret-missing': return { detail: `the secret store has no secret named ${refusal.secretName}` };
    default: return {};
  }
}

// The run refused, before any driver call.
function refuseRun(planned: lifecycle.Planned, refusal: lifecycle.Refusal, context: NothingRanContext, startedAt: number): RunResult {
  const refused = lifecycle.refuse(planned, refusal);
  logKeepingTheResult({ kind: 'run.state', state: refused.state, targetId: planned.target.id, code: refused.refusal.code, ...loggedWithRefusal(refusal) }, context.logger);
  return seal(refusedResult(refused.refusal, planned.target.id, context.ports.clock.now() - startedAt), context);
}

type OpenedSession = {
  readonly session: Session;
  readonly driver: BrowserDriver;
  // Inputs the run could not pin, for the manifest's nonHermeticInputs.
  readonly unpinned: readonly string[];
  // The sha256 of the executable the driver launched, when it reports its build.
  readonly executableSha256?: string;
};

// True when the adapter the target names cannot pin the clock, the time zone or randomness.
function cannotPinDeterminism(drivers: ReadonlyMap<string, BrowserDriver>, target: Target): boolean {
  const cannotPin = adapterRegistry(drivers).find(target.adapter)?.info.cannotPin ?? [];
  return cannotPin.some((input) => DETERMINISM_INPUTS.includes(input));
}

// Resolves the target in order, stopping at the first "no": only the adapter the target names is
// asked, it is asked once, and nothing else is tried in its place. The build is hashed, and
// checked against the lockfile when there is one, before anything launches.
async function openSession(planned: lifecycle.Planned, context: RunContext): Promise<Result<OpenedSession, Unavailable>> {
  const driver = adapterRegistry(context.ports.drivers).find(planned.target.adapter);
  if (driver === null) return { ok: false, error: { reason: 'adapter-not-registered', detail: `no adapter '${planned.target.adapter}'` } };
  const supported = driver.supports(planned.target);
  if (!supported.ok) return supported;
  const checked = await checkPinnedBuild(driver, planned.target, context.inputs.lockEntries);
  if (!checked.ok) return checked;
  const unpinned = checked.value.unpinned ? [BROWSER_BUILD_INPUT] : [];
  const executableSha256 = checked.value.executableSha256;
  const opened = await driver.open(planned.target, {
    baseUrl: context.inputs.baseUrl,
    allowedOrigins: reachableOrigins(context.cleared),
    seed: context.inputs.seed,
    // The page sees the plan clock's time; the manifest keeps the run's own clock start.
    fixedTimeMilliseconds: resolvePlanClock(context.cleared.plan.clock, context.inputs.fixedTimeMilliseconds, planned.target.timezone),
    sensitiveSelectors: context.ports.redactor.selectors,
    timeoutMilliseconds: context.cleared.project.limits.stepTimeoutMilliseconds,
    // Only a plan that advances the clock puts the page's timers on virtual time; every other plan
    // keeps real-time timers, as pages that wait on their own timers need.
    ...(totalClockAdvanceMilliseconds(context.cleared.plan) > 0 ? { virtualTimers: true } : {}),
  });
  if (!opened.ok) return opened;
  return { ok: true, value: { session: opened.value, driver, unpinned, ...(executableSha256 === undefined ? {} : { executableSha256 }) } };
}

// A failed step's result that holds only its code.
const failedStep = (step: Step, index: number, code: StepCode): StepResult => ({ index, type: step.type, ...stepFailed(code) });

const hasARefusedDecision = (context: StepContext): boolean => context.session.refusedRequestDecisions().length > 0;

// The code for something that threw, whose text goes only to the log, which redacts it. A read of the
// page says what stopped it and never throws, but a throw from anything else cannot say the page died.
function codeForThrow(error: unknown, session: DocumentSession, logger: Logger): StepCode {
  const code = session.crashed() ? TARGET_CRASHED : ADAPTER_ERROR;
  logger.log({ kind: 'step.end', outcome: 'failed', code, detail: errorText(error) });
  return code;
}

// What a step fails with when a read of the page gave nothing. A dialog and a crash are the page's to
// answer for. A read that gave nothing for any other reason is the adapter's.
const STEP_CODE_OF_FAILED_READ = {
  [PageReadFailureCode.DialogOpen]: StepCode.DialogOpen,
  [PageReadFailureCode.TargetCrashed]: StepCode.TargetCrashed,
  [PageReadFailureCode.PageUnreadable]: StepCode.AdapterError,
} as const satisfies Record<PageReadFailureCode, StepCode>;
type FailedReadCode = (typeof STEP_CODE_OF_FAILED_READ)[PageReadFailureCode];

// The adapter's own failure keeps its text, which goes only to the log, which redacts it.
function codeOfFailedRead(readFailure: PageReadFailure, logger: Logger): FailedReadCode {
  const code = STEP_CODE_OF_FAILED_READ[readFailure.code];
  if (code === ADAPTER_ERROR) {
    logger.log({ kind: 'step.end', outcome: 'failed', code, detail: readFailure.detail });
  }
  return code;
}

const PAGE_READ_FAILURE_CODES: readonly DriverErrorCode[] = Object.values(PageReadFailureCode);
const isPageReadFailure = (error: DriverError): error is PageReadFailure => PAGE_READ_FAILURE_CODES.includes(error.code);

// A capture fails as a read of the page does, or with the code the driver gave for anything else,
// such as a field a secret was typed into that it could not find to hide.
const codeOfFailedCapture = (error: DriverError, logger: Logger): StepCode =>
  isPageReadFailure(error) ? codeOfFailedRead(error, logger) : error.code;

// The requests the plan checks are observed from its start, so what a page sends as it loads counts
// too. Gives the code for what stopped it, or undefined when nothing did.
async function failureToObserveRequests(session: Session, context: StepContext): Promise<StepCode | undefined> {
  try {
    const observing = await startObserving(observedRequestNames(context.cleared.plan), networkContext(context));
    if (observing.ok) {
      return undefined;
    }
    return codeForThrow(`the requests the plan checks could not be observed: ${observing.error}`, session, context.logger);
  } catch (error) {
    return codeForThrow(error, session, context.logger);
  }
}

const EGRESS_UNREAD = 'egress-unread';

// The result claims what the egress refused and is hashed with that claim in it. So this is the one
// record read after the verdict that can't take an empty default: an empty list says nothing was
// refused, and when that isn't known the run has no verdict to give.
function readBlockedOrigins(session: Session): Result<readonly string[], unknown> {
  try {
    return success([...new Set(session.blockedOrigins())].sort());
  } catch (error) {
    return failure(error);
  }
}

// By now the steps have a verdict, and a person needs it more than anything a broken session or log
// has left to say. What cannot be read goes to the log, if the log still works, and takes `otherwise`.
function readKeepingTheResult<Value>(read: () => Value, otherwise: Value, logger: Logger): Value {
  try {
    return read();
  } catch (error) {
    logFailureAfterTheVerdict('session-records-unread', error, logger);
    return otherwise;
  }
}

function logFailureAfterTheVerdict(code: string, error: unknown, logger: Logger): void {
  try {
    logger.log({ kind: 'step.end', outcome: 'failed', code, detail: errorText(error) });
  } catch {
    // The log is what failed, and the result is all that is left to say it with.
  }
}

// Logs what happened where a failing log must not reject the run. True when the log took it.
function logKeepingTheResult(event: Parameters<Logger['log']>[0], logger: Logger): boolean {
  try {
    logger.log(event);
    return true;
  } catch {
    return false;
  }
}

// A session that will not close, such as a browser profile Windows still holds, says nothing about
// what the steps found. It stays out of the result, whose hash a replay on a calmer machine must match.
// Nor does one that never answers hold the result back. Whatever comes of it after that goes unlogged, so
// the failure is logged once.
async function closeKeepingTheResult(session: Session, clock: Clock, logger: Logger): Promise<void> {
  const closeFailed = 'session-close-failed';
  const progress = { hasEnded: false, hasStoppedWaiting: false };
  const closing = (async () => {
    try {
      await session.close();
    } catch (error) {
      if (!progress.hasStoppedWaiting) {
        logFailureAfterTheVerdict(closeFailed, error, logger);
      }
    } finally {
      progress.hasEnded = true;
    }
  })();
  try {
    // A close with nothing to wait for has ended after one turn, which takes nothing from the clock.
    await Promise.race([closing, clock.sleep(0)]);
    const deadline = clock.now() + LONGEST_SESSION_CLOSE_MILLISECONDS;
    while (!progress.hasEnded) {
      if (clock.now() >= deadline) {
        progress.hasStoppedWaiting = true;
        logFailureAfterTheVerdict(closeFailed, `the session did not close within ${LONGEST_SESSION_CLOSE_MILLISECONDS} ms`, logger);
        return;
      }
      await Promise.race([closing, clock.sleep(POLL_INTERVAL_MILLISECONDS)]);
    }
  } catch (error) {
    // Only the clock can have failed, and with no clock there is no deadline to wait for the close by.
    if (!progress.hasEnded) {
      progress.hasStoppedWaiting = true;
      logFailureAfterTheVerdict(closeFailed, error, logger);
    }
  }
}

// One step, wherever in the plan it stands, with what its driver alone cannot be trusted to report:
// a browser already dead, a check that passed from memory while it died, a throw, and a denial.
async function runStep(step: Step, index: number, session: DocumentSession, target: Target, context: StepContext): Promise<StepResult> {
  const denialsBefore = context.denials.length;
  const result = await runStepOnLivePage(step, index, session, target, context);
  // The audit log holds this denial, so whatever the driver reported from the same moment must not
  // turn the verdict into an ordinary failure.
  if (context.denials.length > denialsBefore) {
    return failedStep(step, index, 'policy-denied');
  }
  return withActiveStubs(step, result, context.activeStubs);
}

async function runStepOnLivePage(step: Step, index: number, session: DocumentSession, target: Target, context: StepContext): Promise<StepResult> {
  if (session.crashed()) {
    return failedStep(step, index, TARGET_CRASHED);
  }
  const openingsBefore = session.unsupportedOpenings();
  try {
    const done = await executeStep(step, index, session, target, context);
    // A request the browser would not let go on stays held, so neither a pass nor a failure of this
    // step says anything about the app: the run could not test. The reason goes to the log at the end.
    if (hasARefusedDecision(context)) {
      return { ...done, ...stepFailed(ADAPTER_ERROR) };
    }
    if (done.outcome !== 'passed') {
      return done;
    }
    if (ASSERTION_STEP_TYPES.includes(step.type) && session.crashed()) {
      return failedStep(step, index, TARGET_CRASHED);
    }
    // A popup or a download that no step asked for fails the step under way, so a run cannot pass as
    // if nothing had opened.
    return session.unsupportedOpenings() > openingsBefore ? failedStep(step, index, 'unsupported-step') : done;
  } catch (error) {
    return failedStep(step, index, codeForThrow(error, session, context.logger));
  }
}

// True when a passed step left something beyond its outcome for a person to read.
const holdsARecord = (done: StepResult): boolean => Object.keys(done).some((key) => key !== 'index' && key !== 'type' && key !== 'outcome');

// The steps of a frame or newTab step, in order, in the document they stand in. They have no results
// of their own in the plan's list: the first that fails fails the frame or newTab step, with its code,
// observation and records, and the records of those before it are kept beside them.
async function runInnerSteps(
  container: Extract<Step, { type: 'frame' | 'newTab' }>, index: number, session: DocumentSession, target: Target, context: StepContext,
): Promise<StepResult> {
  const kept: StepResult[] = [];
  const withKept = (result: StepResult, nested: readonly StepResult[] = []): StepResult =>
    (kept.length + nested.length === 0 ? result : { ...result, innerSteps: [...kept, ...nested] });
  for (const inner of container.steps) {
    const done = await runStep(inner, index, session, target, context);
    if (done.outcome !== 'passed') {
      if (SETUP_STEP_TYPES.includes(inner.type)) {
        context.setupFailedInside.add(index);
      }
      return withKept({ ...done, type: container.type }, done.innerSteps);
    }
    if (holdsARecord(done)) {
      kept.push(done);
    }
  }
  return withKept({ index, type: container.type, outcome: 'passed' });
}

// An assertion's result with the stubs active while it ran, so a report can tell a check of a faked
// answer from a check of the real backend. A stub step never checks anything, so the stubs active
// as the step ends are the ones active while it ran.
function withActiveStubs(step: Step, result: StepResult, activeStubs: ReadonlySet<StubName>): StepResult {
  if (activeStubs.size === 0 || !ASSERTION_STEP_TYPES.includes(step.type)) return result;
  return { ...result, activeStubs: [...activeStubs].sort() };
}

// What the stub, request-check and storage steps use: the run's session, values and the secrets
// resolved for stub starts and storage writes.
const networkContext = (context: StepContext): NetworkStepContext => ({
  project: context.cleared.project, session: context.session, values: context.values, remembered: context.remembered,
  secrets: stubAndStorageSecretStore(context.secrets), clock: context.ports.clock, activeStubs: context.activeStubs,
});

// What the clock and clipboard steps use: the run's session and values.
const clockAndClipboardContext = (context: StepContext): ClockAndClipboardContext => ({
  project: context.cleared.project, session: context.session, values: context.values, remembered: context.remembered,
  clock: context.ports.clock,
});

// What the page-script steps use: the run's values and the declared scripts' sources.
const pageScriptContext = (context: RunContext): PageScriptContext => ({
  project: context.cleared.project, scriptSources: context.inputs.scriptSources ?? {}, values: context.values,
  remembered: context.remembered, clock: context.ports.clock, logger: context.logger, holdsSecret: context.holdsSecret,
});

// What the runtime guard is given for a step that acts on no element.
const NO_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

// Runs one step on a document of the page: the top document, or an iframe's for the steps inside a
// frame step, which report under the frame step's own index.
async function executeStep(step: Step, index: number, session: DocumentSession, target: Target, context: StepContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  switch (step.type) {
    case 'navigate': {
      let path = step.url;
      if (typeof path !== 'string') {
        // A path template's values are only known now, so the runtime guard checks the final URL.
        const resolved = resolvePathTemplate(path, context.values, context.cleared.project);
        if (!resolved.ok) return { ...base, ...stepFailed(resolved.error) };
        path = resolved.value;
        const verdict = context.gate.guardAction({ type: 'navigate', url: path }, index, NO_ELEMENT, null, target.locale);
        if (verdict.kind === 'deny') {
          keepDenial(verdict, context);
          return { ...base, ...stepFailed(StepCode.PolicyDenied) };
        }
      }
      const url = new URL(path, context.inputs.baseUrl);
      if (!context.cleared.project.origins.some((origin) => origin === url.origin)) return { ...base, ...stepFailed(StepCode.OriginNotAllowed) };
      const navigated = await session.navigate(url.href, { scripts: step.scripts ?? NavigateScripts.Enabled });
      return navigated.ok ? { ...base, outcome: 'passed' } : { ...base, ...stepFailed(navigated.error.code) };
    }
    case 'click':
    case 'hover':
    case 'fill':
    case 'select':
    case 'upload':
    case 'press': {
      // Values are substituted first, so the runtime guard and the driver see the final text.
      const action = resolveActionStep(step, context.values, context.cleared.project);
      if (!action.ok) return { ...base, ...stepFailed(action.error) };
      const resolved = action.value;
      const performable = withFillSecret(resolved, context.secrets);
      // Marked before acting: a fill that fails part way may still have typed some of the secret.
      if (performable.type === 'fill') markFilledField(performable, context.secretFilledFields);
      const acted = await session.act(performable, guardFor(resolved, index, target, context));
      return acted.ok ? { ...base, outcome: 'passed' } : { ...base, ...stepFailed(acted.error.code) };
    }
    case 'dialog': {
      // The driver answers the dialog the page opened, asking the runtime guard first with the
      // dialog's text, so accepting an irreversible one ends the run Denied with nothing sent.
      const answer = resolveDialogStep(step, context);
      if (!answer.ok) return { ...base, ...stepFailed(answer.error) };
      const acted = await session.act(answer.value, guardFor(answer.value, index, target, context));
      return acted.ok ? { ...base, outcome: 'passed' } : { ...base, ...stepFailed(acted.error.code) };
    }
    case 'frame': {
      const locator = resolveLocator(step.locator, context.values, context.cleared.project);
      if (!locator.ok) return { ...base, ...stepFailed(locator.error) };
      const entered = await session.frame(locator.value);
      if (!entered.ok) return { ...base, ...stepFailed(entered.error.code) };
      return runInnerSteps(step, index, entered.value, target, context);
    }
    case 'remember':
      if ('response' in step.from) return { ...base, ...(await rememberFromResponse(step, step.from, index, networkContext(context))) };
      if ('clipboard' in step.from) return { ...base, ...(await rememberFromClipboard(step, index, clockAndClipboardContext(context))) };
      return rememberFromPage(step, step.from, index, session, context);
    case 'download': return downloadFile(step, index, session, target, context);
    case 'expectDownload': return checkDownload(step, index, context);
    case 'newTab': return runInNewTab(step, index, target, context);
    // The session's network and storage ports carry these out.
    case 'stub': return { ...base, ...(await runStubStep(step, networkContext(context))) };
    case 'resetRequests': return { ...base, ...(await resetRequests(step, networkContext(context))) };
    case 'expectRequests': return { ...base, ...(await checkRequests(step, networkContext(context))) };
    case 'expectResponse': return { ...base, ...(await checkResponse(step, networkContext(context))) };
    case 'setStorage': case 'removeStorage': return { ...base, ...(await writeStorage(step, networkContext(context))) };
    case 'expectStorage': return { ...base, ...(await checkStorage(step, networkContext(context))) };
    // The session's clock and clipboard ports carry these out.
    case 'advanceClock': return { ...base, ...(await advanceClock(step, clockAndClipboardContext(context))) };
    case 'expectClipboard': return { ...base, ...(await checkClipboard(step, clockAndClipboardContext(context))) };
    // Page scripts run through the script port of the document the step stands in.
    case 'evaluate': return { ...base, ...(await runEvaluate(step, index, session, pageScriptContext(context))) };
    case 'expectScript': return { ...base, ...(await runScriptCheck(step, index, session, pageScriptContext(context))) };
    // Database commands run in a workload container through the run's port, not in the browser. A
    // run that runs them always has a runner: run() refused it before any step otherwise.
    case 'database':
    case 'expectDatabase': {
      const done = step.type === 'database' ? await runDatabaseStep(step, index, context.commands) : await runDatabaseCheck(step, index, context.commands);
      return { ...base, ...done };
    }
    case 'expect': {
      const locator = resolveLocator(step.locator, context.values, context.cleared.project);
      if (!locator.ok) return { ...base, ...stepFailed(locator.error) };
      const assertion = resolveElementAssertion(step.assert, context.values, context.cleared.project);
      if (!assertion.ok) return { ...base, ...stepFailed(assertion.error) };
      // A DOM check asks the probe to read the class, style or attribute it compares.
      const read = domReadFor(assertion.value);
      let last: ElementProbe | null = null;
      const verdict = await poll(context, session, async () => {
        last = await session.probe(locator.value, read);
        return checkElement(assertion.value, last, context.inputs.baseUrl);
      });
      if (isCheckStopped(verdict)) return { ...base, ...stepFailed(verdict.code) };
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, ...stepFailed(verdict.code ?? StepCode.AssertionFailed), observed: observe(last, context, context.secretFilledFields.has(canonicalJson(locator.value))) };
    }
    case 'expectPage': {
      const assertion = resolvePageAssertion(step.assert, context);
      if (!assertion.ok) return { ...base, ...stepFailed(assertion.error) };
      let title = '';
      const verdict = await poll(context, session, async () => {
        const page = await session.page();
        if (!page.ok) {
          return verdictOfFailedRead(page.error, context.logger);
        }
        title = page.value.title;
        return checkPage(assertion.value, page.value, context.inputs.baseUrl);
      });
      if (isCheckStopped(verdict)) {
        return { ...base, ...stepFailed(verdict.code) };
      }
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, ...stepFailed(verdict.code ?? StepCode.AssertionFailed), observed: context.isShortSecret(title) ? SECRET_PLACEHOLDER : context.redactor.text(title) };
    }
    case 'a11yAudit': {
      const audited = await session.audit();
      if (!audited.ok) {
        return { ...base, ...stepFailed(codeOfFailedRead(audited.error, context.logger)) };
      }
      const findings = [...audited.value].sort(byRuleId);
      context.logger.log({ kind: 'audit', stepIndex: index, findings: findings.length });
      const gateFails = step.mode === 'gate' && findings.length > 0;
      return { ...base, outcome: gateFails ? 'failed' : 'passed', findings, ...(gateFails ? { code: StepCode.AccessibilityViolations } : {}) };
    }
    case 'call':
    case 'expectBackend': {
      // A run that calls services always has a caller: run() refused it before any step otherwise.
      const done = step.type === 'call' ? await runCallStep(step, index, context.calls) : await runBackendCheck(step, index, context.calls);
      return { ...base, ...done };
    }
    case 'capture': {
      const taken = await pixelsWithSecretsHidden(session, context);
      if (!taken.ok) {
        return taken.error.code === StepCode.NotFound
          ? { ...base, outcome: 'passed', code: StepCode.CaptureLeftOut }
          : { ...base, ...stepFailed(codeOfFailedCapture(taken.error, context.logger)) };
      }
      const reference = await context.ports.artifacts.put(`${target.id}/${step.name}.png`, taken.value, 'image/png');
      context.logger.log({ kind: 'artifact', stepIndex: index, artifact: reference.name, sha256: reference.sha256 });
      return { ...base, outcome: 'passed', artifact: reference };
    }
  }
}

function byRuleId(left: A11yFinding, right: A11yFinding): number {
  if (left.ruleId === right.ruleId) {
    return 0;
  }
  return left.ruleId < right.ruleId ? -1 : 1;
}

// The viewport with personal data and every field a secret was typed into masked. Not-found says one of
// those fields cannot be masked: text drawn as pixels is out of reach of any later scan, so no image is
// better than an image that may show the secret. Any other failure says the page could not be captured.
async function pixelsWithSecretsHidden(session: DocumentSession, context: RunContext): Promise<Result<Uint8Array, DriverError>> {
  const selectors = context.ports.redactor.selectors;
  const fields = [...context.secretFilledFields.values()];
  if (fields.length === 0) {
    return session.screenshot(selectors);
  }
  return session.screenshotHidingFields(selectors, fields, context.holdsSecret);
}

// Reads a remember step's value from the page through the prober, waiting as a check waits until
// the locator matches one element with non-empty text (or input value), whitespace normalised, or
// with a non-empty attribute, taken exactly as the page holds it.
// The text must be safe text no longer than the project's maximumTextLength. Only the value's name
// and sha256 are kept in the result and the events, never the text.
async function rememberFromPage(
  step: Extract<Step, { type: 'remember' }>, from: RememberedElementSource, index: number, session: DocumentSession, context: RunContext,
): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  const locator = resolveLocator(from.element, context.values, context.cleared.project);
  if (!locator.ok) return { ...base, ...stepFailed(locator.error) };
  // A remembered value is hashed into the result and can be sent on by a later step, and a hash of
  // a short secret is as good as the secret.
  if (context.secretFilledFields.has(canonicalJson(locator.value))) {
    return { ...base, ...stepFailed(StepCode.ValueHoldsSecret) };
  }
  const read: DomRead | null = from.read === 'attribute' ? { kind: 'attribute', name: from.attribute } : null;
  const textOf = (element: OneElementRead): string => {
    if (from.read === 'attribute') {
      return element.dom?.kind === 'attribute' ? element.dom.value ?? '' : '';
    }
    return normalise(from.read === 'value' ? element.value ?? '' : element.text);
  };
  const seen = { text: '' };
  const verdict = await poll(context, session, async (): Promise<Verdict> => {
    const probe = await session.probe(locator.value, read);
    const found = oneElementOf(probe);
    if (!found.ok) {
      return { pass: false, code: found.error };
    }
    seen.text = textOf(found.value);
    return seen.text === '' ? { pass: false, code: null } : { pass: true, code: null };
  });
  // A remember step keeps no observation, so a stopped check and the check's own answer fail it alike.
  if (!verdict.pass) return { ...base, ...stepFailed(verdict.code ?? StepCode.ValueEmpty) };
  const kept = context.remembered.remember(step.name, seen.text, index);
  return kept.ok ? { ...base, outcome: 'passed', remembered: kept.value } : { ...base, ...stepFailed(kept.error) };
}

// A page check with a meta tag's expected content resolved, when it is a value reference.
function resolvePageAssertion(assertion: PageAssertion, context: RunContext): Result<PageAssertion, StepCode> {
  if (assertion.kind !== 'metaContent') return { ok: true, value: assertion };
  const expected = resolveText(assertion.value, context.values, context.cleared.project.limits.maximumTextLength);
  return expected.ok ? { ok: true, value: { ...assertion, value: expected.value } } : expected;
}

// A download step: the driver clicks the element, asking the runtime guard first as for any click,
// and saves the one file the click starts, within the project's maximumDownloadBytes. The file is
// kept in memory under the plan's name for the checks after it; the result keeps only its name,
// media type, size and sha256.
async function downloadFile(step: DownloadStep, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  const locator = resolveLocator(step.locator, context.values, context.cleared.project);
  if (!locator.ok) return { ...base, ...stepFailed(locator.error) };
  const resolved: ResolvedDownloadStep = { type: step.type, name: step.name, locator: locator.value };
  const saved = await session.download(resolved, context.cleared.project.limits.maximumDownloadBytes, guardFor(resolved, index, target, context));
  if (!saved.ok) return { ...base, ...stepFailed(saved.error.code) };
  const file = saved.value;
  context.downloads.set(step.name, file);
  const record: DownloadRecord = {
    downloadName: step.name, fileName: keptText(file.fileName, context), mediaType: keptText(file.mediaType, context),
    size: file.bytes.length, sha256: file.sha256,
  };
  return { ...base, outcome: 'passed', download: record };
}

// Text the server chose that a result keeps, such as a file name: redacted and capped.
const keptText = (text: string, context: RunContext): string => (context.isShortSecret(text) ? SECRET_PLACEHOLDER : context.redactor.text(text).slice(0, 200));

// A media type's essence, such as "text/csv" for "text/csv; charset=utf-8", in lower case.
const mediaTypeEssence = (mediaType: string): string => (mediaType.split(';')[0] ?? '').trim().toLowerCase();

// The file's bytes as text, or undefined when they are not UTF-8 text: invalid UTF-8, or a NUL
// byte, which no text file holds.
function downloadText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

// Checks a file an earlier download step saved. None of its text is ever kept: a failed check
// keeps only its code.
function checkDownload(step: Extract<Step, { type: 'expectDownload' }>, index: number, context: RunContext): StepResult {
  const base = { index, type: step.type } as const;
  // The parser rejects a check of a download no earlier step defined, and a failed download skips
  // every later step, so the file is always there.
  const file = context.downloads.get(step.download);
  if (file === undefined) return { ...base, ...stepFailed(StepCode.NoDownload) };
  const verdict = (pass: boolean): StepResult => (pass ? { ...base, outcome: 'passed' } : { ...base, ...stepFailed(StepCode.AssertionFailed) });
  const assertion = step.assert;
  switch (assertion.kind) {
    case 'sizeAtMost': return verdict(file.bytes.length <= assertion.value);
    case 'sizeAtLeast': return verdict(file.bytes.length >= assertion.value);
    case 'mediaTypeEquals': return verdict(mediaTypeEssence(file.mediaType) === mediaTypeEssence(assertion.value));
    case 'fileNameEquals': case 'contentContains': case 'contentExcludes': {
      const expected = resolveText(assertion.value, context.values, context.cleared.project.limits.maximumTextLength);
      if (!expected.ok) return { ...base, ...stepFailed(expected.error) };
      if (assertion.kind === 'fileNameEquals') return verdict(file.fileName === expected.value);
      const text = downloadText(file.bytes);
      if (text === undefined) return { ...base, ...stepFailed(StepCode.DownloadNotText) };
      // An empty file proves nothing about what it holds or leaves out, so it fails both.
      if (text === '') return verdict(false);
      return verdict(assertion.kind === 'contentContains' ? text.includes(expected.value) : !text.includes(expected.value));
    }
  }
}

// A newTab step: opens its URL in a second tab of the session's browser context, runs its steps
// there in order and closes the tab, whatever they did. A tab that will not close fails a step that
// had passed, and never takes the place of a real failure.
async function runInNewTab(step: Extract<Step, { type: 'newTab' }>, index: number, target: Target, context: StepContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  let path = step.url;
  if (typeof path !== 'string') {
    // As for a navigate: a path template's values are only known now, so the guard checks the final URL.
    const resolved = resolvePathTemplate(path, context.values, context.cleared.project);
    if (!resolved.ok) return { ...base, ...stepFailed(resolved.error) };
    path = resolved.value;
    const verdict = context.gate.guardAction({ type: 'navigate', url: path }, index, NO_ELEMENT, null, target.locale);
    if (verdict.kind === 'deny') {
      keepDenial(verdict, context);
      return { ...base, ...stepFailed(StepCode.PolicyDenied) };
    }
  }
  const url = new URL(path, context.inputs.baseUrl);
  if (!context.cleared.project.origins.some((origin) => origin === url.origin)) return { ...base, ...stepFailed(StepCode.OriginNotAllowed) };
  const opened = await context.session.newTab(url.href);
  if (!opened.ok) return { ...base, ...stepFailed(opened.error.code) };
  const tab = opened.value;
  const done = await runInnerSteps(step, index, tab, target, context);
  try {
    await tab.close();
    return done;
  } catch (error) {
    const code = codeForThrow(error, tab, context.logger);
    return done.outcome === 'passed' ? { ...done, ...stepFailed(code) } : done;
  }
}

// A dialog step with its expected text's value references replaced, as a driver must receive it.
function resolveDialogStep(step: DialogStep, context: RunContext): Result<ResolvedDialogStep, StepCode> {
  if (step.expectText === undefined) return success({ type: step.type, action: step.action });
  const expected = resolveText(step.expectText, context.values, context.cleared.project.limits.maximumTextLength);
  return expected.ok ? success({ type: step.type, action: step.action, expectText: expected.value }) : expected;
}

// The action as the driver performs it: a fill of a secret reference carries the secret the run
// resolved for it, opaque, so the driver reveals it only as it types.
function withFillSecret(action: ResolvedActionStep, secrets: ResolvedSecrets): PerformableAction {
  if (action.type !== 'fill') return action;
  const { type, locator, value } = action;
  return { type, locator, value: fillValueOf(value, secrets) };
}

function fillValueOf(value: Extract<ResolvedActionStep, { type: 'fill' }>['value'], secrets: ResolvedSecrets): FillValue {
  if (typeof value === 'string') return { kind: FillValueKind.Text, text: value };
  return 'lines' in value
    ? { kind: FillValueKind.Lines, lines: value.lines }
    : { kind: FillValueKind.Secret, secret: fillSecretOf(secrets, value.secretName) };
}

// Keeps the fields whose last fill typed a secret, by their locator.
function markFilledField(fill: PerformableFill, secretFilledFields: Map<string, ResolvedLocator>): void {
  const key = canonicalJson(fill.locator);
  switch (fill.value.kind) {
    case FillValueKind.Secret: secretFilledFields.set(key, fill.locator); break;
    case FillValueKind.Text: case FillValueKind.Lines: secretFilledFields.delete(key); break;
  }
}

// Keeps the runtime guard's denial, so the run can end Denied naming the rule, and marked
// unrecorded when the audit sink did not record it.
function keepDenial(verdict: Extract<GuardVerdict, { kind: 'deny' }>, context: RunContext): void {
  context.denials.push({ rule: verdict.rule, stepIndex: verdict.stepIndex, ...(verdict.unrecorded ? { unrecorded: true } : {}) });
}

// The runtime guard the driver asks before the step's input event, with the element it resolved
// and, for a dialog step, the open dialog's text.
function guardFor(step: Step, index: number, target: Target, context: RunContext): ActionGuard {
  return (element, dialogText) => {
    const verdict = context.gate.guardAction(step, index, element, dialogText, target.locale);
    if (verdict.kind === 'deny') keepDenial(verdict, context);
    return verdict;
  };
}

const TARGET_CRASHED = StepCode.TargetCrashed;
// A check the page stopped rather than answered: its renderer died while the check waited, or a read
// of it failed for a reason that is the adapter's. What the check last saw then says nothing about the
// page, so the step fails with this code and keeps no observation. Every other failed verdict is the
// check's own answer, which the step fails with, keeping what it saw where the step has an observation.
type CheckStopped = { readonly pass: false; readonly code: typeof TARGET_CRASHED | typeof ADAPTER_ERROR };
type PollVerdict = Verdict | CheckStopped;
const isCheckStopped = (verdict: PollVerdict): verdict is CheckStopped => verdict.code === TARGET_CRASHED || verdict.code === ADAPTER_ERROR;

const verdictOfFailedRead = (readFailure: PageReadFailure, logger: Logger): PollVerdict => ({ pass: false, code: codeOfFailedRead(readFailure, logger) });

// Repeats a check until it passes or the step timeout runs out. A page that crashes stops the
// wait at once: nothing on it can change any more, and the same goes for a read of the page that failed.
async function poll(context: RunContext, session: DocumentSession, check: () => Promise<PollVerdict>): Promise<PollVerdict> {
  const deadline = context.ports.clock.now() + context.cleared.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    const verdict = await check();
    // Looked at before a pass is accepted: what a dying page last showed proves nothing. A probe has no
    // count for a crash either, so one that read nothing on a dead page is told apart here.
    if (session.crashed()) return { pass: false, code: TARGET_CRASHED };
    // Waiting cannot change a selector the browser rejects, a dialog, which only a later step can
    // answer, the browser's own error page, which runs no script that could leave it, or a read that failed.
    if (verdict.pass || isCheckStopped(verdict) || verdict.code === 'selector-invalid' || verdict.code === UnreadablePage.DialogOpen
      || verdict.code === 'navigation-failed') return verdict;
    if (context.ports.clock.now() >= deadline) return verdict;
    await context.ports.clock.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

const UNREADABLE_PAGE_OBSERVATIONS = {
  [UnreadablePage.ReadFailed]: '(page unreadable)',
  [UnreadablePage.DialogOpen]: '(a dialog is open)',
  [UnreadablePage.BrowserErrorPage]: '(the browser shows its own error page)',
} as const satisfies Record<UnreadablePage, string>;

// What a failed check saw, redacted: never the text of a sensitive element, nothing read from a
// field a secret was typed into, and no text that is a whole short secret.
function observe(probe: ElementProbe | null, context: RunContext, filledFromSecret: boolean): string {
  if (probe === null || probe.count === 0 || probe.count === 'selector-invalid') {
    return '(no element)';
  }
  if (typeof probe.count === 'string') {
    return UNREADABLE_PAGE_OBSERVATIONS[probe.count];
  }
  if (!isOneElementRead(probe)) {
    return `(${probe.count} elements)`;
  }
  if (probe.sensitive) return SENSITIVE_PLACEHOLDER;
  const asWritten = probe.value ?? probe.text;
  if (filledFromSecret || context.isShortSecret(asWritten)) return SECRET_PLACEHOLDER;
  // Secrets go while the text is as the page wrote it. Collapsing first could join what a secret
  // holds apart; personal-data patterns come after, as they read collapsed text.
  const seen = normalise(context.withoutSecrets(asWritten));
  return context.redactor.text(withoutRememberedTexts(seen, context.rememberedTexts)).slice(0, 200);
}

// Shown instead of a remembered value's text in what a failed check observed.
const REMEMBERED_PLACEHOLDER = '[redacted:remembered-value]';
// Shorter remembered texts, such as "3", are replaced only when they are the whole observation:
// searched for inside longer text they would blank out unrelated characters.
const SHORTEST_REMEMBERED_SEARCH = 8;

// An observation with every text a remember step read replaced, so a remembered value never
// reaches the result through a failed check.
function withoutRememberedTexts(observed: string, remembered: ReadonlySet<string>): string {
  if (remembered.has(observed)) return REMEMBERED_PLACEHOLDER;
  let kept = observed;
  const longestFirst = [...remembered].filter((text) => text.length >= SHORTEST_REMEMBERED_SEARCH).sort((left, right) => right.length - left.length);
  for (const text of longestFirst) kept = kept.split(text).join(REMEMBERED_PLACEHOLDER);
  return kept;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function unavailableResult(targetId: string, unavailable: Unavailable, context: NothingRanContext, startedAt: number): RunResult {
  logKeepingTheResult({ kind: 'run.state', state: 'TargetUnavailable', targetId, code: unavailable.reason }, context.logger);
  return seal(targetUnavailableResult(unavailable, targetId, context.ports.clock.now() - startedAt), context);
}

// What a plan run vouches for: decided by the plan, its project's recording setting, the run's
// isolation and the target's adapter alone, so two runs of one plan say the same, unless one leaves its
// egress unread, which loses the claim as it does for an evidence run. Egress, credentials and replay
// are claimed only for a run whose isolation port says the isolated runner enforced egress; any other
// run counts as running on the host.
const planRunGuarantees = (context: SealContext, unsafeFeatures: readonly UnsafeFeature[], isEgressUnread: boolean): GuaranteeStatement => {
  const { plan, project } = context.cleared;
  const repliesNotRecorded = callsServices(plan) && project.replay?.recordReplies !== true;
  const isIsolated = context.ports.isolation.guaranteeLevel() === 'isolated';
  return guaranteeStatement({
    mode: 'plan', egressEnforced: isIsolated && !isEgressUnread, unmaskedScreenshotsKept: false, unsafeFeatures,
    ...(context.determinismUnpinned ? { determinismUnpinned: true } : {}),
    ...(repliesNotRecorded ? { repliesNotRecorded } : {}),
  });
};

// What a result is sealed with: the plan, project and standing it was judged as, which a target that
// is not declared has too.
type SealContext = { readonly cleared: RunSubject; readonly ports: RunPorts; readonly determinismUnpinned: boolean };
// What a run that ended before any step needs: the seal, and the log it ends on.
type NothingRanContext = SealContext & { readonly logger: Logger };

// Adds the run mode, the guarantee statement, the unsafe label (for a plan using unsafe features),
// the approval label (for an approved plan) and the result's two hashes.
function seal(outcome: Omit<RunResult, 'resultHash' | 'evidenceHash' | 'approvalLabel' | 'mode' | 'guarantees' | 'unsafeFeatures'>, context: SealContext): RunResult {
  const standing = context.cleared.standing;
  const unsafeFeatures = unsafeFeaturesOf(context.cleared.plan);
  const isEgressUnread = (outcome.reviewItems ?? []).some((item) => item.code === EGRESS_UNREAD);
  const labelled = {
    ...outcome, mode: 'plan' as const, guarantees: planRunGuarantees(context, unsafeFeatures, isEgressUnread),
    ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
  };
  return withRunHashes(standing.mode === 'approved' ? { ...labelled, approvalLabel: approvalLabel(standing.approval) } : labelled);
}
