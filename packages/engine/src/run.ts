// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports; page scripts through its script port. Database commands
// go through the run's DatabaseCommandRunner port, which runs each in a workload container.
import {
  failure, isElementCheckNoDriverDecides, needsDriverFeatures, success, UnreadablePage,
  type A11yFinding, type ActionGuard, type AppliedRewrite, type ApprovalLabel, type ArtifactReference, type ArtifactStore, type Authorised,
  type BrowserDriver, type Clock, type DatabaseCommandRunner, type DocumentSession, type DomRead, type DownloadedFile, type DownloadName, type DriverFeature, type LockEntry, type DialogStep, type ElementProbe,
  type EventSink, type GuaranteeLevel, type GuardVerdict, type PageAssertion, type Plan, type PolicyRuleId, type Redactor,
  type DownloadStep, type ResolvedElement, type ResolvedLocator, type Result, type SafeText, type SecretStore, type ServiceCaller, type Session, type Step, type Target, type TargetId,
  type Unavailable, type ValueName, type GuaranteeStatement, type RunMode, type SuiteFinding, type SuiteName, type SuitePass,
  type StubAnswer, type StubName, type SuiteTestId, type SuiteTestResult, type UnsafeFeature,
} from '@revisum/contracts';
import { approvalLabel, ownStanding, type PlanStanding } from './approval/plan-standing.ts';
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
import { runEvaluate, runScriptCheck, type PageScriptContext, type PageScriptRecord } from './page-scripts/page-script-steps.ts';
import type { SuiteDecodeError } from './evidence/suite-report.ts';
import type { PlanError } from './plan/plan-decoders.ts';
import { ASSERTION_STEP_TYPES } from './plan/plan-grammar.ts';
import { assertBranded, everyPlanStep } from './plan/plan-parser.ts';
import { unsafeFeaturesOf } from './plan/unsafe-features.ts';
import { assertAuthorised, isClearedForStanding, policyGate, type PolicyGate } from './policy/policy-gate.ts';
import type { Project } from './project/project-parser.ts';
import { declaredCommands } from './project/unsafe-feature-declarations.ts';
import { SENSITIVE_PLACEHOLDER } from './redaction.ts';
import { rememberedValues, type RememberedValues } from './RememberedValues.ts';
import { withResultHash } from './result-hash.ts';
import {
  generateRunValues, resolveActionStep, resolveElementAssertion, resolveLocator, resolvePathTemplate, resolvePlanClock, resolveText, type RunValues,
} from './run-values.ts';
import {
  NO_SECRETS, commandSecretStore, resolvePlanSecrets, resolvedSecretStore, secretEchoRemoval, secretRecords, shortSecretObservation, stubAndStorageSecretStore, withSecretRedaction,
  type ResolvedSecrets,
} from './secrets/secret-resolution.ts';
import { SECRET_PLACEHOLDER } from './secrets/secret-values.ts';
import { adapterRegistry } from './target/adapter-registry.ts';
import { BROWSER_BUILD_INPUT, checkPinnedBuild } from './target/target-lock.ts';
import {
  NO_ANSWER_CODES, runBackendCheck, runCallStep, runCleanup, type CallStepContext, type CleanupResult, type ServiceCallRecord,
} from './service-calls/call-steps.ts';

export type RunInputs = {
  // Only the policy gate makes an Authorised plan, so a plan it has not cleared does not type-check.
  readonly plan: Authorised;
  readonly project: Project;
  readonly targetId: TargetId;
  readonly baseUrl: string;
  readonly seed: number;
  readonly fixedTimeMilliseconds: number;
  readonly fixtures: readonly FixtureReference[];
  readonly host: HostInfo;
  // The plan's standing (planStanding). Absent means no approval was supplied, so the run is a
  // proposal: it never reaches the project's production origins. An approved plan reaches them
  // only when the project's policy allows production for approved plans. A standing whose
  // approval is for another plan's hash is ignored: the run is a proposal.
  readonly standing?: PlanStanding;
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
  // How strongly the run is isolated, set by whoever started it from Runner.guaranteeLevel(). Only
  // 'isolated' makes the result state that egress was enforced; absent means 'host', so no run can
  // claim isolation by leaving it out. The manifest does not record it, so a replay of an isolated
  // run must be given it too, or its result hash differs and the replay is a mismatch.
  readonly guaranteeLevel?: GuaranteeLevel;
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

export type StepOutcome = 'passed' | 'failed' | 'skipped';
export type StepResult = {
  readonly index: number;
  readonly type: Step['type'];
  readonly outcome: StepOutcome;
  readonly code?: string;
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
  // Hash of everything above except the manifest body, which its own hash covers. Timings are excluded.
  readonly resultHash: string;
  readonly timings: { readonly totalMilliseconds: number; readonly stepMilliseconds: readonly number[] };
};

export type Rejected = { readonly state: 'Rejected'; readonly errors: readonly PlanError[] };
// A parsed plan the policy gate's static check denied, so no run started. `unrecorded` is present
// when the audit sink failed to record the denial.
export type DeniedPlan = { readonly state: 'Denied'; readonly rule: PolicyRuleId; readonly stepIndex: number | null; readonly unrecorded?: true };

type RunContext = {
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
  // The optional plan features the session's driver performs; none until a session is open.
  readonly performs: readonly DriverFeature[];
  // The open session, whose newTab port a newTab step uses; null until a session is open.
  readonly session: Session | null;
  // The files download steps saved, by the name the plan gives each, for later checks. The bytes
  // stay in memory for the run only.
  readonly downloads: Map<DownloadName, DownloadedFile>;
  // What the call steps use, when the run has a service caller.
  readonly calls: CallStepContext | undefined;
  // What the database steps use, when the run has a database-command port.
  readonly commands: DatabaseCommandContext | undefined;
  // The stubs started and not yet stopped.
  readonly activeStubs: Set<StubName>;
  // True when the target's adapter cannot pin the clock, the time zone or randomness, so the run
  // loses replay-identical. Known from the target alone, before anything runs.
  readonly determinismUnpinned: boolean;
  // The plan steps whose frame or second tab holds a setup step that failed. A frame or newTab step
  // reports under its own type, so its type alone cannot say the run could not test.
  readonly setupFailedInside: Set<number>;
};

const POLL_INTERVAL_MILLISECONDS = 50;

export async function run(given: RunInputs, ports: RunPorts): Promise<RunResult> {
  // First, before any side effect: a plan the parser did not make is refused, whatever its type says.
  assertBranded(given.plan);
  // A standing lent from another plan is dropped here, so production, the origin allow-list and
  // the approval label all see the plan as the proposal it is.
  const standing = ownStanding(given.plan, given.standing);
  const inputs: RunInputs = { ...given, standing };
  const startedAt = ports.clock.now();
  const target = inputs.project.matrix.find((candidate) => candidate.id === inputs.targetId);
  const declared = target !== undefined && inputs.plan.targets.includes(inputs.targetId);
  const runId = sha256(`${sha256(canonicalJson(inputs.plan))}:${inputs.targetId}:${inputs.seed}`).slice(0, 16);
  // Resolving reads only the store, so it can come first: the run's redactor needs the secrets
  // before anything is logged. A missing secret refuses the run below, before any driver call.
  // A command's secrets are needed only by a run that can run commands.
  const commandDeclarations = ports.databaseCommands === undefined ? {} : declaredCommands(inputs.project.unsafeFeatures);
  const resolution = resolvePlanSecrets(inputs.plan, ports.secrets, inputs.project.calls, commandDeclarations);
  const secrets = resolution.ok ? resolution.value : NO_SECRETS;
  const redactor = withSecretRedaction(ports.redactor, secrets);
  const logger = manifestLogger(ports.events, redactor, runId);
  const gate = policyGate({ project: inputs.project, events: ports.audit });
  // Generation is pure, so values exist before anything runs; a run with no target has none.
  const values = new Map<ValueName, SafeText>(target === undefined
    ? [] : generateRunValues(inputs.plan, inputs.seed, inputs.fixedTimeMilliseconds, target, inputs.project));
  const isShortSecret = shortSecretObservation(secrets);
  const withoutSecrets = secretEchoRemoval(secrets);
  const rememberedTexts = new Set<string>();
  const holdsSecret = (text: string): boolean => isShortSecret(text) || withoutSecrets(text) !== text;
  const remembered = rememberedValues({
    values, rememberedTexts, hasSecret: holdsSecret,
    maximumTextLength: inputs.project.limits.maximumTextLength, logger,
  });
  const calls: CallStepContext | undefined = ports.services === undefined ? undefined : {
    caller: ports.services, project: inputs.project, values, remembered, secrets: resolvedSecretStore(secrets), clock: ports.clock, logger, holdsSecret,
  };
  const commands: DatabaseCommandContext | undefined = ports.databaseCommands === undefined ? undefined : {
    runner: ports.databaseCommands, project: inputs.project, values, remembered, secrets: commandSecretStore(secrets), clock: ports.clock, logger, holdsSecret,
  };
  const context: RunContext = {
    inputs, ports, logger, gate, denials: [], redactor, secrets, isShortSecret, withoutSecrets, holdsSecret, secretFilledFields: new Map(), values, remembered, calls,
    commands, rememberedTexts, performs: [], session: null, downloads: new Map(), activeStubs: new Set(), setupFailedInside: new Set(),
    determinismUnpinned: target !== undefined && cannotPinDeterminism(ports.drivers, target),
  };

  if (target === undefined || !declared) {
    return unavailableResult(inputs.targetId, { reason: 'not-declared', detail: 'target is not in both the plan and the matrix' }, context, startedAt);
  }
  // Before any side effect on the target: a plan the gate did not clear for it, under this very
  // project, is refused.
  assertAuthorised(inputs.plan, target.id, inputs.project);
  const planned = lifecycle.plan(inputs.plan, target);
  // A log that fails this early ends the run Errored like one that fails later, once there are steps
  // to account for. It must not reject the run, and a refusal below still stands.
  const isPlanLogged = logKeepingTheResult({ kind: 'run.state', state: planned.state, targetId: target.id }, logger);

  if (!isClearedForStanding(inputs.plan, target.id, inputs.project, standing)) {
    return refusedResult(planned, { code: 'clearance-standing-mismatch' }, context, startedAt);
  }

  // Refused before any driver call if the run would reach a production origin it may not.
  const productionOrigin = productionAllowed(inputs) ? undefined : productionOriginReached(inputs);
  if (productionOrigin !== undefined) {
    return refusedResult(planned, { code: 'origin-not-allowed', origin: productionOrigin }, context, startedAt, { origin: productionOrigin });
  }

  if (!resolution.ok) {
    return refusedResult(planned, { code: 'secret-missing', secretName: resolution.error }, context, startedAt, {
      detail: `the secret store has no secret named ${resolution.error}`,
    });
  }

  // Refused before any side effect when the plan names a page script whose source the run was not
  // given: the manifest could not record what would run.
  const unsafe = unsafeFeatureRecord(inputs.plan, inputs.project, inputs.scriptSources ?? {});
  if (!unsafe.ok) {
    return refusedResult(planned, { code: 'script-source-missing', file: unsafe.error }, context, startedAt);
  }

  const beyondThisRun = refusalOfWhatThisRunCannotDo(inputs.plan, context);
  if (beyondThisRun !== undefined) {
    return refusedResult(planned, beyondThisRun, context, startedAt);
  }

  const opened = await openSession(planned, context);
  if (!opened.ok) {
    const unavailable = lifecycle.targetUnavailable(planned, opened.error);
    return unavailableResult(target.id, unavailable.unavailable, context, startedAt);
  }
  const { session, driver, executableSha256 } = opened.value;
  // A database command's output, and the database it ran against, cannot be pinned.
  const unpinned = [...opened.value.unpinned, ...(runsDatabaseCommands(inputs.plan) ? [DATABASE_COMMANDS_INPUT] : [])];
  // From here on, a step needing an optional feature is refused only when this driver lacks it.
  const stepContext: RunContext = { ...context, performs: driver.info.performs ?? [], session };
  const manifestInputs: Parameters<typeof buildManifest>[0] = {
    plan: inputs.plan, target, adapter: driver.info, browser: session.browser,
    seed: inputs.seed, fixedTimeMilliseconds: inputs.fixedTimeMilliseconds, fixtures: inputs.fixtures, host: inputs.host,
    ...secretRecords(secrets), callsServices: callsServices(inputs.plan),
    ...(unsafe.value === undefined ? {} : { unsafe: unsafe.value }),
    ...(unpinned.length === 0 ? {} : { unpinned }),
    ...(executableSha256 === undefined ? {} : { executableSha256 }),
    ...(inputs.pins === undefined ? {} : { pins: { pins: inputs.pins, project: inputs.project } }),
    recordsReplies: inputs.project.replay?.recordReplies === true,
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
    for (const [index, step] of inputs.plan.steps.entries()) {
      if (steps.some((done) => done.outcome === 'failed')) { steps.push({ index, type: step.type, outcome: 'skipped' }); continue; }
      const stepStartedAt = ports.clock.now();
      logger.log({ kind: 'step.start', stepIndex: index, stepType: step.type });
      // The first step stands for what could not be started, so the result says why nothing ran.
      const done = index === 0 && notObserved !== undefined ? failedStep(step, index, notObserved) : await runStep(step, index, session, target, stepContext);
      // With no later step to notice, a crash the last step did not report would go unseen.
      const isLastStep = index === inputs.plan.steps.length - 1;
      const result = isLastStep && done.outcome === 'passed' && isCrashed(session) ? failedStep(step, index, TARGET_CRASHED) : done;
      stepMilliseconds.push(ports.clock.now() - stepStartedAt);
      steps.push(result);
      logger.log({
        kind: 'step.end', stepIndex: index, stepType: step.type, outcome: result.outcome,
        durationMilliseconds: stepMilliseconds[stepMilliseconds.length - 1] ?? 0, ...(result.code ? { code: result.code } : {}),
      });
    }
    // In the try: a port that cannot say what it rewrote must not leave a mutated run reading as plain.
    rewrites = ports.rewritesApplied?.() ?? [];
    // A denied action failed its step, so every later step was skipped and nothing ran after it.
    // A failed call, page script or database command could not set up or reach what the test
    // needs, and a page script that threw, hung or gave no usable result, or a backend check whose
    // call got no answer, could not check it, which is not a product failure.
    const denial = context.denials[0];
    finished = denial !== undefined && steps.some((done) => done.code === 'policy-denied')
      ? lifecycle.deny(running, denial)
      : steps.some((done) => couldNotTest(done, stepContext))
        ? lifecycle.finish(running, 'Errored')
        : lifecycle.finish(running, steps.every((done) => done.outcome === 'passed') ? 'Passed' : 'Failed');
  } catch {
    // A step's own failures never get here, so only the log or the clock can have failed. The result
    // still accounts for every step.
    const [unfinished, ...unreached] = inputs.plan.steps.slice(steps.length);
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
    stubAnswers = readKeepingTheResult(() => session.network?.stubAnswers() ?? [], [], logger);
    await closeKeepingTheResult(session, logger);
  }
  // Whatever the outcome. A failing cleanup step never changes the verdict; it raises a review item.
  const cleanup = inputs.plan.cleanup === undefined ? undefined : await runCleanup(inputs.plan.cleanup, inputs.plan.steps.length, calls, commands);
  const cleanupItems = (cleanup ?? []).flatMap((done): RunReviewItem[] => (done.outcome === 'failed' ? [{ code: 'cleanup-failed', cleanupIndex: done.index }] : []));
  const blockedRead = readBlockedOrigins(session);
  if (!blockedRead.ok) {
    logFailureAfterTheVerdict(EGRESS_UNREAD, blockedRead.error, logger);
  }
  const blocked = blockedRead.ok ? blockedRead.value : [];
  const reviewItems: readonly RunReviewItem[] = blockedRead.ok ? cleanupItems : [...cleanupItems, { code: EGRESS_UNREAD }];
  const endState = blockedRead.ok ? finished : lifecycle.finish(running, 'Errored');
  readKeepingTheResult(() => {
    for (const { origin, message } of session.connectionFailures?.() ?? []) {
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

// The only entry point for untrusted input, such as a plan an AI proposed. Parsing happens first,
// then the policy gate's static check against the project, for the plan's declared targets and
// standing; on any error or denial no driver method is called.
export async function runUntrusted(
  input: unknown,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
  base: Omit<RunInputs, 'plan' | 'targetId'>,
  ports: RunPorts,
): Promise<Rejected | DeniedPlan | readonly RunResult[]> {
  const parsed = parsePlan(input);
  if (!parsed.ok) return { state: 'Rejected', errors: parsed.error };
  const gate = policyGate({ project: base.project, events: ports.audit });
  const targets = base.project.matrix.filter((target) => parsed.value.targets.includes(target.id));
  const decision = gate.decide(parsed.value, targets, base.standing);
  if (decision.kind === 'deny') {
    return { state: 'Denied', rule: decision.rule, stepIndex: decision.stepIndex, ...(decision.unrecorded ? { unrecorded: true } : {}) };
  }
  const results: RunResult[] = [];
  for (const targetId of decision.plan.targets) results.push(await run({ ...base, plan: decision.plan, targetId }, ports));
  return results;
}

// Production is closed to every run unless the plan is approved and the project's policy allows
// production for approved plans.
const productionAllowed = (inputs: RunInputs): boolean =>
  inputs.standing?.mode === 'approved' && inputs.project.policy.allowProductionForApprovedPlans;

// The steps that set up or reach what the test needs: when one fails, the run could not test.
const SETUP_STEP_TYPES: readonly Step['type'][] = ['call', 'evaluate', 'database'];
// A step the adapter threw on: what it saw is unknown, which is not a product failure either. The
// code stands for the failure and its text stays out of the result, since it could hold page
// content or a secret.
const ADAPTER_ERROR = 'adapter-error';
// The codes of a page script or a database command that could not give a result to check, in
// whatever step it ran, of a service call that got no answer, and of an adapter that threw: the run
// could not test, which is not a product failure.
const UNUSABLE_RESULT_CODES: readonly string[] = [
  'script-failed', 'script-timeout', 'script-result-invalid', 'script-result-too-large', ADAPTER_ERROR, ...COMMAND_ERROR_CODES, ...NO_ANSWER_CODES,
];

// True when a failed step means the run could not test, wherever in the plan the step stands.
const couldNotTest = (done: StepResult, context: RunContext): boolean =>
  done.outcome === 'failed' && (SETUP_STEP_TYPES.includes(done.type) || UNUSABLE_RESULT_CODES.includes(done.code ?? '') || context.setupFailedInside.has(done.index));

// True when the plan calls a declared service, anywhere in it.
const callsServices = (plan: Plan): boolean => everyPlanStep(plan).some((step) => step.type === 'call' || step.type === 'expectBackend');

// True when the plan runs a database command, anywhere in it.
const runsDatabaseCommands = (plan: Plan): boolean => everyPlanStep(plan).some((step) => step.type === 'database' || step.type === 'expectDatabase');

// Why this run could not do all the plan asks, known from the plan and the run's ports alone, so
// nothing has acted yet. A plan that needs one of these relies on it to mean anything: stopping
// part way would leave test data behind or report on a run that never had what it declared.
function refusalOfWhatThisRunCannotDo(plan: Plan, context: RunContext): lifecycle.Refusal | undefined {
  if (callsServices(plan) && context.calls === undefined) {
    return { code: 'services-unavailable' };
  }
  // A plan that names it relies on being signed in. Loading it comes with the driver's session
  // environment; until then no run can honour it, so the plan parses and every run of it is refused.
  if (plan.storageState !== undefined) {
    return { code: 'storage-state-unsupported' };
  }
  if (everyPlanStep(plan).some(isElementCheckNoDriverDecides)) {
    return { code: 'element-check-unsupported' };
  }
  // Cleanup counts too: with no way to run it, the steps would leave their test data behind.
  if (runsDatabaseCommands(plan) && context.commands === undefined) {
    return { code: 'database-commands-unavailable' };
  }
  return undefined;
}

// The run refused, before any driver call. `logged` adds what the event log says beyond the code.
function refusedResult(
  planned: lifecycle.Planned, refusal: lifecycle.Refusal, context: RunContext, startedAt: number,
  logged: { readonly origin?: string; readonly detail?: string } = {},
): RunResult {
  const refused = lifecycle.refuse(planned, refusal);
  logKeepingTheResult({ kind: 'run.state', state: refused.state, targetId: planned.target.id, code: refused.refusal.code, ...logged }, context.logger);
  return seal({
    state: refused.state, targetId: planned.target.id, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
    unavailable: null, refusal: refused.refusal, timings: { totalMilliseconds: context.ports.clock.now() - startedAt, stepMilliseconds: [] },
  }, context);
}

// The origins of the services the plan's calls and database commands reach, its cleanup included.
function serviceOrigins(inputs: RunInputs): string[] {
  const steps = [...inputs.plan.steps, ...(inputs.plan.cleanup ?? [])];
  const commands = declaredCommands(inputs.project.unsafeFeatures);
  return steps.flatMap((step) => {
    let serviceName: string | undefined;
    if (step.type === 'call' || step.type === 'expectBackend') serviceName = Object.entries(inputs.project.calls).find(([name]) => name === step.call)?.[1].service;
    else if (step.type === 'database' || step.type === 'expectDatabase') serviceName = Object.entries(commands).find(([name]) => name === step.command)?.[1].service;
    const service = inputs.project.services.find((candidate) => candidate.name === serviceName);
    return service === undefined ? [] : [service.origin];
  });
}

// The first production origin the run would reach: its base URL, a navigate step or a second tab's
// URL, inside frames and second tabs too, or a declared call's service.
function productionOriginReached(inputs: RunInputs): string | undefined {
  const production = new Set<string>(inputs.project.productionOrigins);
  if (production.size === 0) return undefined;
  const origins = [new URL(inputs.baseUrl).origin];
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      // A path template always stays on the base URL's origin, already in the list.
      if ((step.type === 'navigate' || step.type === 'newTab') && typeof step.url === 'string') origins.push(new URL(step.url, inputs.baseUrl).origin);
      if (step.type === 'frame' || step.type === 'newTab') visit(step.steps);
    }
  };
  visit(inputs.plan.steps);
  origins.push(...serviceOrigins(inputs));
  return origins.find((origin) => production.has(origin));
}

// The origins the browser may reach. A run that may not reach production has the production origins
// left out of its allow-list as well, so any request the page makes to one is blocked.
function reachableOrigins(inputs: RunInputs): readonly string[] {
  if (productionAllowed(inputs)) return inputs.project.origins;
  const production = new Set<string>(inputs.project.productionOrigins);
  return inputs.project.origins.filter((origin) => !production.has(origin));
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
    allowedOrigins: reachableOrigins(context.inputs),
    seed: context.inputs.seed,
    // The page sees the plan clock's time; the manifest keeps the run's own clock start.
    fixedTimeMilliseconds: resolvePlanClock(context.inputs.plan.clock, context.inputs.fixedTimeMilliseconds, planned.target.timezone),
    sensitiveSelectors: context.ports.redactor.selectors,
    timeoutMilliseconds: context.inputs.project.limits.stepTimeoutMilliseconds,
    // Only a plan that advances the clock puts the page's timers on virtual time; every other plan
    // keeps real-time timers, as pages that wait on their own timers need.
    ...(totalClockAdvanceMilliseconds(context.inputs.plan) > 0 ? { virtualTimers: true } : {}),
  });
  if (!opened.ok) return opened;
  return { ok: true, value: { session: opened.value, driver, unpinned, ...(executableSha256 === undefined ? {} : { executableSha256 }) } };
}

// A failed step's result that holds only its code.
const failedStep = (step: Step, index: number, code: string): StepResult => ({ index, type: step.type, outcome: 'failed', code });

const isCrashed = (session: DocumentSession): boolean => session.crashed?.() === true;
const isHeldByDialog = (session: DocumentSession): boolean => session.isDialogOpen?.() === true;

function adapterFailureCode(session: DocumentSession): string {
  if (isCrashed(session)) {
    return TARGET_CRASHED;
  }
  return isHeldByDialog(session) ? UnreadablePage.DialogOpen : ADAPTER_ERROR;
}

// The code for something that threw, whose text goes only to the log, which redacts it. A throw from
// a dead page is the crash, and one from a page a dialog holds is that dialog.
function codeForThrow(error: unknown, session: DocumentSession, logger: Logger): string {
  const code = adapterFailureCode(session);
  logger.log({ kind: 'step.end', outcome: 'failed', code, detail: errorText(error) });
  return code;
}

// The requests the plan checks are observed from its start, so what a page sends as it loads counts
// too. A driver refused request checks observes nothing: those steps fail on their own. Gives the
// code for what stopped it, or undefined when nothing did.
async function failureToObserveRequests(session: Session, context: RunContext): Promise<string | undefined> {
  if (!context.performs.includes('requestChecks')) {
    return undefined;
  }
  try {
    const observing = await startObserving(observedRequestNames(context.inputs.plan), networkContext(context));
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
async function closeKeepingTheResult(session: Session, logger: Logger): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    logFailureAfterTheVerdict('session-close-failed', error, logger);
  }
}

// One step, wherever in the plan it stands, with what its driver alone cannot be trusted to report:
// a browser already dead, a check that passed from memory while it died, a throw, and a denial.
async function runStep(step: Step, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  const denialsBefore = context.denials.length;
  const result = await runStepOnLivePage(step, index, session, target, context);
  // The audit log holds this denial, so whatever the driver reported from the same moment must not
  // turn the verdict into an ordinary failure.
  if (context.denials.length > denialsBefore) {
    return failedStep(step, index, 'policy-denied');
  }
  return withActiveStubs(step, result, context.activeStubs);
}

async function runStepOnLivePage(step: Step, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  if (isCrashed(session)) {
    return failedStep(step, index, TARGET_CRASHED);
  }
  const openingsBefore = session.unsupportedOpenings?.() ?? 0;
  try {
    const done = await executeStep(step, index, session, target, context);
    if (done.outcome !== 'passed') {
      return done;
    }
    if (ASSERTION_STEP_TYPES.includes(step.type) && isCrashed(session)) {
      return failedStep(step, index, TARGET_CRASHED);
    }
    // A popup or a download that no step asked for fails the step under way, so a run cannot pass as
    // if nothing had opened.
    return (session.unsupportedOpenings?.() ?? 0) > openingsBefore ? failedStep(step, index, 'unsupported-step') : done;
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
  container: Extract<Step, { type: 'frame' | 'newTab' }>, index: number, session: DocumentSession, target: Target, context: RunContext,
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
const networkContext = (context: RunContext): NetworkStepContext => ({
  project: context.inputs.project, session: context.session, values: context.values, remembered: context.remembered,
  secrets: stubAndStorageSecretStore(context.secrets), clock: context.ports.clock, activeStubs: context.activeStubs,
});

// What the clock and clipboard steps use: the run's session and values.
const clockAndClipboardContext = (context: RunContext): ClockAndClipboardContext => ({
  project: context.inputs.project, session: context.session, values: context.values, remembered: context.remembered,
  clock: context.ports.clock,
});

// What the page-script steps use: the run's values and the declared scripts' sources.
const pageScriptContext = (context: RunContext): PageScriptContext => ({
  project: context.inputs.project, scriptSources: context.inputs.scriptSources ?? {}, values: context.values,
  remembered: context.remembered, clock: context.ports.clock, logger: context.logger, holdsSecret: context.holdsSecret,
});

// What the runtime guard is given for a step that acts on no element.
const NO_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

// Runs one step on a document of the page: the top document, or an iframe's for the steps inside a
// frame step, which report under the frame step's own index.
async function executeStep(step: Step, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  // Steps the plan language has but the run's driver does not perform. Each fails with
  // unsupported-step, never passes or is skipped, and nothing of it reaches the driver, so a plan
  // that relies on one cannot report a pass it did not earn or act in part. What a step needs from
  // a driver, and which of it is optional, is decided in one place, in contracts; the driver declares
  // the optional features it performs. Hover, select and upload go to the driver, which refuses them
  // the same way when it does not perform them; a frame step needs the driver's frame port.
  if (needsDriverFeatures(step, context.performs)) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  switch (step.type) {
    case 'navigate': {
      let path = step.url;
      if (typeof path !== 'string') {
        // A path template's values are only known now, so the runtime guard checks the final URL.
        const resolved = resolvePathTemplate(path, context.values, context.inputs.project);
        if (!resolved.ok) return { ...base, outcome: 'failed', code: resolved.error };
        path = resolved.value;
        const verdict = context.gate.guardAction({ type: 'navigate', url: path }, index, NO_ELEMENT, null, target.locale);
        if (verdict.kind === 'deny') {
          keepDenial(verdict, context);
          return { ...base, outcome: 'failed', code: 'policy-denied' };
        }
      }
      const url = new URL(path, context.inputs.baseUrl);
      if (!context.inputs.project.origins.some((origin) => origin === url.origin)) return { ...base, outcome: 'failed', code: 'origin-not-allowed' };
      // Scripts are named only when they are off, so a driver that never loads a page without them
      // is called exactly as before.
      const navigated = step.scripts === 'disabled' ? await session.navigate(url.href, { scripts: 'disabled' }) : await session.navigate(url.href);
      return navigated.ok ? { ...base, outcome: 'passed' } : { ...base, outcome: 'failed', code: navigated.error.code };
    }
    case 'click':
    case 'hover':
    case 'fill':
    case 'select':
    case 'upload':
    case 'press': {
      // Values are substituted first, so the runtime guard and the driver see the final text.
      const action = resolveActionStep(step, context.values, context.inputs.project);
      if (!action.ok) return { ...base, outcome: 'failed', code: action.error };
      const resolved = action.value;
      // A secret is handed to the driver opaque; it is revealed only as the driver types it.
      const secret = resolved.type === 'fill' && typeof resolved.value !== 'string' && 'secretName' in resolved.value
        ? context.secrets.fills.get(resolved.value.secretName) : undefined;
      // Marked before acting: a fill that fails part way may still have typed some of the secret.
      if (resolved.type === 'fill') {
        if (secret === undefined) context.secretFilledFields.delete(canonicalJson(resolved.locator));
        else context.secretFilledFields.set(canonicalJson(resolved.locator), resolved.locator);
      }
      const acted = await session.act(resolved, guardFor(resolved, index, target, context), secret);
      return acted.ok ? { ...base, outcome: 'passed' } : { ...base, outcome: 'failed', code: acted.error.code };
    }
    case 'dialog': {
      // The driver answers the dialog the page opened, asking the runtime guard first with the
      // dialog's text, so accepting an irreversible one ends the run Denied with nothing sent.
      const answer = resolveDialogStep(step, context);
      if (!answer.ok) return { ...base, outcome: 'failed', code: answer.error };
      const acted = await session.act(answer.value, guardFor(answer.value, index, target, context));
      return acted.ok ? { ...base, outcome: 'passed' } : { ...base, outcome: 'failed', code: acted.error.code };
    }
    case 'frame': {
      if (session.frame === undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
      const locator = resolveLocator(step.locator, context.values, context.inputs.project);
      if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
      const entered = await session.frame(locator.value);
      if (!entered.ok) return { ...base, outcome: 'failed', code: entered.error.code };
      return runInnerSteps(step, index, entered.value, target, context);
    }
    case 'remember':
      if ('response' in step.from) return { ...base, ...(await rememberFromResponse(step, index, networkContext(context))) };
      if ('clipboard' in step.from) return { ...base, ...(await rememberFromClipboard(step, index, clockAndClipboardContext(context))) };
      return rememberFromPage(step, index, session, context);
    case 'download': return downloadFile(step, index, session, target, context);
    case 'expectDownload': return checkDownload(step, index, context);
    case 'newTab': return runInNewTab(step, index, target, context);
    // The session's network and storage ports carry these out, for a driver that declares them.
    case 'stub': return { ...base, ...(await runStubStep(step, networkContext(context))) };
    case 'resetRequests': return { ...base, ...(await resetRequests(step, networkContext(context))) };
    case 'expectRequests': return { ...base, ...(await checkRequests(step, networkContext(context))) };
    case 'expectResponse': return { ...base, ...(await checkResponse(step, networkContext(context))) };
    case 'setStorage': case 'removeStorage': return { ...base, ...(await writeStorage(step, networkContext(context))) };
    case 'expectStorage': return { ...base, ...(await checkStorage(step, networkContext(context))) };
    // The session's clock and clipboard ports carry these out, for a driver that declares them;
    // needsDriverFeatures refused them above otherwise, so an advance never becomes a real wait.
    case 'advanceClock': return { ...base, ...(await advanceClock(step, clockAndClipboardContext(context))) };
    case 'expectClipboard': return { ...base, ...(await checkClipboard(step, clockAndClipboardContext(context))) };
    // Page scripts run through the script port of the document the step stands in, for a driver
    // that declares them; needsDriverFeatures refused them above otherwise.
    case 'evaluate': return { ...base, ...(await runEvaluate(step, index, session, pageScriptContext(context))) };
    case 'expectScript': return { ...base, ...(await runScriptCheck(step, index, session, pageScriptContext(context))) };
    // Database commands run in a workload container through the run's port, not in the browser. A
    // run that runs them always has a runner: run() refused it before any step otherwise.
    case 'database':
    case 'expectDatabase': {
      if (context.commands === undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
      const done = step.type === 'database' ? await runDatabaseStep(step, index, context.commands) : await runDatabaseCheck(step, index, context.commands);
      return { ...base, ...done };
    }
    case 'expect': {
      const locator = resolveLocator(step.locator, context.values, context.inputs.project);
      if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
      const assertion = resolveElementAssertion(step.assert, context.values, context.inputs.project);
      if (!assertion.ok) return { ...base, outcome: 'failed', code: assertion.error };
      // A DOM check asks the probe to read the class, style or attribute it compares.
      const read = domReadFor(assertion.value);
      let last: ElementProbe | null = null;
      const verdict = await poll(context, session, async () => {
        last = read === undefined ? await session.probe(locator.value) : await session.probe(locator.value, read);
        return checkElement(assertion.value, last, context.inputs.baseUrl);
      });
      if (verdict.code === TARGET_CRASHED) return { ...base, outcome: 'failed', code: TARGET_CRASHED };
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, outcome: 'failed', code: verdict.code ?? 'assertion-failed', observed: observe(last, context, context.secretFilledFields.has(canonicalJson(locator.value))) };
    }
    case 'expectPage': {
      const assertion = resolvePageAssertion(step.assert, context);
      if (!assertion.ok) return { ...base, outcome: 'failed', code: assertion.error };
      let title = '';
      const verdict = await poll(context, session, async () => {
        const page = await session.page();
        title = page.title;
        return checkPage(assertion.value, page, context.inputs.baseUrl);
      });
      if (verdict.code === TARGET_CRASHED) return { ...base, outcome: 'failed', code: TARGET_CRASHED };
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, outcome: 'failed', code: verdict.code ?? 'assertion-failed', observed: context.isShortSecret(title) ? SECRET_PLACEHOLDER : context.redactor.text(title) };
    }
    case 'a11yAudit': {
      const findings = [...(await session.audit())].sort((left, right) => (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
      context.logger.log({ kind: 'audit', stepIndex: index, findings: findings.length });
      const gateFails = step.mode === 'gate' && findings.length > 0;
      return { ...base, outcome: gateFails ? 'failed' : 'passed', findings, ...(gateFails ? { code: 'a11y-violations' } : {}) };
    }
    case 'call':
    case 'expectBackend': {
      // A run that calls services always has a caller: run() refused it before any step otherwise.
      if (context.calls === undefined) return { ...base, outcome: 'failed', code: 'service-unreachable' };
      const done = step.type === 'call' ? await runCallStep(step, index, context.calls) : await runBackendCheck(step, index, context.calls);
      return { ...base, ...done };
    }
    case 'capture': {
      const png = await pixelsWithSecretsHidden(session, context);
      if (png === null) {
        return { ...base, outcome: 'passed', code: 'capture-left-out' };
      }
      const reference = await context.ports.artifacts.put(`${target.id}/${step.name}.png`, png, 'image/png');
      context.logger.log({ kind: 'artifact', stepIndex: index, artifact: reference.name, sha256: reference.sha256 });
      return { ...base, outcome: 'passed', artifact: reference };
    }
  }
}

// The viewport with personal data and every field a secret was typed into masked, or null when one
// of those fields cannot be masked: text drawn as pixels is out of reach of any later scan, so no
// image is better than an image that may show the secret.
async function pixelsWithSecretsHidden(session: DocumentSession, context: RunContext): Promise<Uint8Array | null> {
  const selectors = context.ports.redactor.selectors;
  const fields = [...context.secretFilledFields.values()];
  if (fields.length === 0) {
    return session.screenshot(selectors);
  }
  if (session.screenshotHidingFields === undefined) {
    return null;
  }
  const taken = await session.screenshotHidingFields(selectors, fields, context.holdsSecret);
  return taken.ok ? taken.value : null;
}

// Reads a remember step's value from the page through the prober, waiting as a check waits until
// the locator matches one element with non-empty text (or input value), whitespace normalised, or
// with a non-empty attribute, taken exactly as the page holds it.
// The text must be safe text no longer than the project's maximumTextLength. Only the value's name
// and sha256 are kept in the result and the events, never the text.
async function rememberFromPage(step: Extract<Step, { type: 'remember' }>, index: number, session: DocumentSession, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  const from = step.from;
  // needsDriverFeatures refused every other source before the step got here.
  if (!('element' in from)) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  const locator = resolveLocator(from.element, context.values, context.inputs.project);
  if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
  // A remembered value is hashed into the result and can be sent on by a later step, and a hash of
  // a short secret is as good as the secret.
  if (context.secretFilledFields.has(canonicalJson(locator.value))) {
    return { ...base, outcome: 'failed', code: 'value-holds-secret' };
  }
  const read: DomRead | undefined = from.read === 'attribute' ? { kind: 'attribute', name: from.attribute } : undefined;
  const textOf = (probe: ElementProbe): string => {
    if (from.read === 'attribute') return probe.dom?.kind === 'attribute' ? probe.dom.value ?? '' : '';
    return normalise(from.read === 'value' ? probe.value ?? '' : probe.text);
  };
  const seen: { probe: ElementProbe | null } = { probe: null };
  const verdict = await poll(context, session, async (): Promise<Verdict> => {
    const probe = read === undefined ? await session.probe(locator.value) : await session.probe(locator.value, read);
    seen.probe = probe;
    if (typeof probe.count === 'string') {
      return { pass: false, code: probe.count };
    }
    if (probe.selectorInvalid === true) return { pass: false, code: 'selector-invalid' };
    if (probe.count === 0) return { pass: false, code: 'not-found' };
    if (probe.count > 1) return { pass: false, code: 'ambiguous' };
    return textOf(probe) === '' ? { pass: false, code: null } : { pass: true, code: null };
  });
  if (verdict.code === TARGET_CRASHED || verdict.code === 'not-found' || verdict.code === 'ambiguous' || verdict.code === 'selector-invalid'
    || verdict.code === UnreadablePage.ReadFailed || verdict.code === UnreadablePage.DialogOpen || verdict.code === UnreadablePage.BrowserErrorPage) {
    return { ...base, outcome: 'failed', code: verdict.code };
  }
  const text = seen.probe === null ? '' : textOf(seen.probe);
  if (text === '') return { ...base, outcome: 'failed', code: 'value-empty' };
  const kept = context.remembered.remember(step.name, text, index);
  return kept.ok ? { ...base, outcome: 'passed', remembered: kept.value } : { ...base, outcome: 'failed', code: kept.error };
}

// A page check with a meta tag's expected content resolved, when it is a value reference.
function resolvePageAssertion(assertion: PageAssertion, context: RunContext): Result<PageAssertion, string> {
  if (assertion.kind !== 'metaContent') return { ok: true, value: assertion };
  const expected = resolveText(assertion.value, context.values, context.inputs.project.limits.maximumTextLength);
  return expected.ok ? { ok: true, value: { ...assertion, value: expected.value } } : expected;
}

// A download step: the driver clicks the element, asking the runtime guard first as for any click,
// and saves the one file the click starts, within the project's maximumDownloadBytes. The file is
// kept in memory under the plan's name for the checks after it; the result keeps only its name,
// media type, size and sha256.
async function downloadFile(step: DownloadStep, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  if (session.download === undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  const locator = resolveLocator(step.locator, context.values, context.inputs.project);
  if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
  const resolved: DownloadStep = { ...step, locator: locator.value };
  const saved = await session.download(resolved, context.inputs.project.limits.maximumDownloadBytes, guardFor(resolved, index, target, context));
  if (!saved.ok) return { ...base, outcome: 'failed', code: saved.error.code };
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
  if (file === undefined) return { ...base, outcome: 'failed', code: 'no-download' };
  const verdict = (pass: boolean): StepResult => (pass ? { ...base, outcome: 'passed' } : { ...base, outcome: 'failed', code: 'assertion-failed' });
  const assertion = step.assert;
  switch (assertion.kind) {
    case 'sizeAtMost': return verdict(file.bytes.length <= assertion.value);
    case 'sizeAtLeast': return verdict(file.bytes.length >= assertion.value);
    case 'mediaTypeEquals': return verdict(mediaTypeEssence(file.mediaType) === mediaTypeEssence(assertion.value));
    case 'fileNameEquals': case 'contentContains': case 'contentExcludes': {
      const expected = resolveText(assertion.value, context.values, context.inputs.project.limits.maximumTextLength);
      if (!expected.ok) return { ...base, outcome: 'failed', code: expected.error };
      if (assertion.kind === 'fileNameEquals') return verdict(file.fileName === expected.value);
      const text = downloadText(file.bytes);
      if (text === undefined) return { ...base, outcome: 'failed', code: 'download-not-text' };
      // An empty file proves nothing about what it holds or leaves out, so it fails both.
      if (text === '') return verdict(false);
      return verdict(assertion.kind === 'contentContains' ? text.includes(expected.value) : !text.includes(expected.value));
    }
  }
}

// A newTab step: opens its URL in a second tab of the session's browser context, runs its steps
// there in order and closes the tab, whatever they did. A tab that will not close fails a step that
// had passed, and never takes the place of a real failure.
async function runInNewTab(step: Extract<Step, { type: 'newTab' }>, index: number, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  const session = context.session;
  if (session === null || session.newTab === undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  let path = step.url;
  if (typeof path !== 'string') {
    // As for a navigate: a path template's values are only known now, so the guard checks the final URL.
    const resolved = resolvePathTemplate(path, context.values, context.inputs.project);
    if (!resolved.ok) return { ...base, outcome: 'failed', code: resolved.error };
    path = resolved.value;
    const verdict = context.gate.guardAction({ type: 'navigate', url: path }, index, NO_ELEMENT, null, target.locale);
    if (verdict.kind === 'deny') {
      keepDenial(verdict, context);
      return { ...base, outcome: 'failed', code: 'policy-denied' };
    }
  }
  const url = new URL(path, context.inputs.baseUrl);
  if (!context.inputs.project.origins.some((origin) => origin === url.origin)) return { ...base, outcome: 'failed', code: 'origin-not-allowed' };
  const opened = await session.newTab(url.href);
  if (!opened.ok) return { ...base, outcome: 'failed', code: opened.error.code };
  const tab = opened.value;
  const done = await runInnerSteps(step, index, tab, target, context);
  try {
    await tab.close();
    return done;
  } catch (error) {
    const code = codeForThrow(error, tab, context.logger);
    return done.outcome === 'passed' ? { ...done, outcome: 'failed', code } : done;
  }
}

// A dialog step with its expected text's value references replaced, as a driver must receive it.
function resolveDialogStep(step: DialogStep, context: RunContext): Result<DialogStep, string> {
  if (step.expectText === undefined) return { ok: true, value: step };
  const expected = resolveText(step.expectText, context.values, context.inputs.project.limits.maximumTextLength);
  return expected.ok ? { ok: true, value: { ...step, expectText: expected.value } } : expected;
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

const TARGET_CRASHED = 'target-crashed';
// A check's verdict, or the page's renderer died while the check waited.
type PollVerdict = Verdict | { readonly pass: false; readonly code: typeof TARGET_CRASHED };

// Repeats a check until it passes or the step timeout runs out. A page that crashes stops the
// wait at once: nothing on it can change any more. A read that threw is tried again, since the page
// may be between two documents.
async function poll(context: RunContext, session: DocumentSession, check: () => Promise<Verdict>): Promise<PollVerdict> {
  const crashed = (): boolean => session.crashed?.() === true;
  const deadline = context.ports.clock.now() + context.inputs.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    let verdict: Verdict;
    try {
      verdict = await check();
    } catch (error) {
      // A read that failed because the page died is the crash, and one a dialog stopped is that
      // dialog; any other failure is the adapter's.
      if (crashed()) return { pass: false, code: TARGET_CRASHED };
      if (isHeldByDialog(session)) {
        return { pass: false, code: UnreadablePage.DialogOpen };
      }
      throw error;
    }
    // Looked at before a pass is accepted: what a dying page last showed proves nothing.
    if (crashed()) return { pass: false, code: TARGET_CRASHED };
    // Waiting cannot change a selector the browser rejects, a dialog, which only a later step can
    // answer, or the browser's own error page, which runs no script that could leave it.
    if (verdict.pass || verdict.code === 'selector-invalid' || verdict.code === UnreadablePage.DialogOpen || verdict.code === 'navigation-failed') return verdict;
    if (context.ports.clock.now() >= deadline) return verdict;
    await context.ports.clock.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

// What a failed check saw, redacted: never the text of a sensitive element, nothing read from a
// field a secret was typed into, and no text that is a whole short secret.
function observe(probe: ElementProbe | null, context: RunContext, filledFromSecret: boolean): string {
  if (probe === null || probe.count === 0) return '(no element)';
  if (probe.count === UnreadablePage.ReadFailed) {
    return '(page unreadable)';
  }
  if (probe.count === UnreadablePage.DialogOpen) {
    return '(a dialog is open)';
  }
  if (probe.count === UnreadablePage.BrowserErrorPage) {
    return '(the browser shows its own error page)';
  }
  if (probe.count > 1) return `(${probe.count} elements)`;
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

function unavailableResult(targetId: string, unavailable: Unavailable, context: RunContext, startedAt: number): RunResult {
  logKeepingTheResult({ kind: 'run.state', state: 'TargetUnavailable', targetId, code: unavailable.reason }, context.logger);
  return seal({
    state: 'TargetUnavailable', targetId, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
    unavailable, timings: { totalMilliseconds: context.ports.clock.now() - startedAt, stepMilliseconds: [] },
  }, context);
}

// What a plan run vouches for: decided by the plan, its project's recording setting, the run's
// isolation and the target's adapter alone, so two runs of one plan say the same, unless one leaves its
// egress unread, which loses the claim as it does for an evidence run. Egress, credentials and replay
// are claimed only for a run whose starter says the isolated runner enforced egress
// (RunInputs.guaranteeLevel); any other run counts as running on the host.
const planRunGuarantees = (inputs: RunInputs, unsafeFeatures: readonly UnsafeFeature[], determinismUnpinned: boolean, isEgressUnread: boolean): GuaranteeStatement => {
  const repliesNotRecorded = callsServices(inputs.plan) && inputs.project.replay?.recordReplies !== true;
  return guaranteeStatement({
    mode: 'plan', egressEnforced: inputs.guaranteeLevel === 'isolated' && !isEgressUnread, unmaskedScreenshotsKept: false, unsafeFeatures,
    ...(determinismUnpinned ? { determinismUnpinned } : {}),
    ...(repliesNotRecorded ? { repliesNotRecorded } : {}),
  });
};

// Adds the run mode, the guarantee statement, the unsafe label (for a plan using unsafe features),
// the approval label (for an approved plan) and the result hash.
function seal(
  outcome: Omit<RunResult, 'resultHash' | 'approvalLabel' | 'mode' | 'guarantees' | 'unsafeFeatures'>,
  context: Pick<RunContext, 'inputs' | 'determinismUnpinned'>,
): RunResult {
  const standing = context.inputs.standing;
  const unsafeFeatures = unsafeFeaturesOf(context.inputs.plan);
  const isEgressUnread = (outcome.reviewItems ?? []).some((item) => item.code === EGRESS_UNREAD);
  const labelled = {
    ...outcome, mode: 'plan' as const, guarantees: planRunGuarantees(context.inputs, unsafeFeatures, context.determinismUnpinned, isEgressUnread),
    ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
  };
  return withResultHash(standing?.mode === 'approved' ? { ...labelled, approvalLabel: approvalLabel(standing.approval) } : labelled);
}
