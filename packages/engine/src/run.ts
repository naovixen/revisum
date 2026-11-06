// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports; page scripts through its script port. Database commands
// go through the run's DatabaseCommandRunner port, which runs each in a workload container.
import {
  failure, UnavailableReason, stepFailed, StepCode, StepOutcome, success,
  type A11yFinding, type AppliedRewrite, type ApprovalLabel, type BrowserDriver, type Clock, type DocumentSession, type Plan, type PolicyRuleId,
  type Redactor, type Result, type SafeText, type Session, type Step, type Target, type Unavailable, type ValueName, type GuaranteeStatement,
  type RunMode, type SuiteFinding, type SuiteName, type SuitePass, type StubAnswer, type StubName, type SuiteTestId, type SuiteTestResult,
  type UnsafeFeature,
} from '@revisum/contracts';
import { approvalLabel, type PlanStanding } from './approval/plan-standing.ts';
import { totalClockAdvanceMilliseconds } from './clock-advance.ts';
import { COMMAND_ERROR_CODES, type DatabaseCommandContext } from './database-commands/database-command-steps.ts';
import { guaranteeStatement } from './guarantees.ts';
import { canonicalJson, sha256 } from './hashing.ts';
import * as lifecycle from './lifecycle.ts';
import { manifestLogger, type Logger } from './logging.ts';
import { observedRequestNames, startObserving } from './network-and-storage/network-and-storage-steps.ts';
import {
  DATABASE_COMMANDS_INPUT, DETERMINISM_INPUTS, buildManifest, manifestHash, unsafeFeatureRecord, type RunManifest,
} from './manifest.ts';
import { refusedResult, targetUnavailableResult } from './NothingRanResult.ts';
import type { SuiteDecodeError } from './evidence/suite-report.ts';
import type { PlanError } from './plan/plan-decoders.ts';
import { isAssertionStepType, isSetupStepType } from './plan/StepFacts.ts';
import { assertBranded } from './plan/plan-parser.ts';
import { unsafeFeaturesOf } from './plan/unsafe-features.ts';
import { assertCleared, ClearedRunKind, type ClearedRun } from './policy/ClearedRun.ts';
import type { TargetNotDeclared } from './policy/TargetNotDeclared.ts';
import { policyGate } from './policy/policy-gate.ts';
import { checkPreflight, secretsToRedact, type PreflightPassed } from './CheckPreflight.ts';
import { callsServices, runsDatabaseCommands } from './plan/CallsServices.ts';
import { reachableOrigins } from './ReachableOrigins.ts';
import type { Project } from './project/project-parser.ts';
import { rememberedValues } from './RememberedValues.ts';
import type { ContainerRunStep, RunStep } from './RunStep.ts';
import { codeForThrow, errorText } from './run/CodeForThrow.ts';
import { networkContext } from './run/executors/network-and-storage/NetworkAndStorageExecutors.ts';
import type { RunInnerSteps, SessionContext } from './run/executors/StepExecutor.ts';
import { executeStep } from './run/executors/StepExecutors.ts';
import { POLL_INTERVAL_MILLISECONDS } from './run/Poll.ts';
import type { RunContext, RunInputs, RunPorts } from './run/RunContext.ts';
import type { StepResult } from './run/StepResult.ts';
import { withRunHashes } from './WithRunHashes.ts';
import { generateRunValues, resolvePlanClock } from './run-values.ts';
import {
  commandSecretStore, resolvedSecretStore, secretEchoRemoval, secretRecords, shortSecretObservation, withSecretRedaction,
  type ResolvedSecrets,
} from './secrets/secret-resolution.ts';
import { adapterRegistry } from './target/adapter-registry.ts';
import { BROWSER_BUILD_INPUT, checkPinnedBuild } from './target/target-lock.ts';
import { NO_ANSWER_CODES, runCleanup, type CallStepContext, type CleanupResult } from './service-calls/call-steps.ts';

export type { RunInputs, RunPorts } from './run/RunContext.ts';
export type { DownloadRecord, RememberedValueRecord, StepResult } from './run/StepResult.ts';

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

// Longer than a driver's stop takes to give up by itself, so this deadline is only for what has wedged.
const LONGEST_SESSION_CLOSE_MILLISECONDS = 60_000;

export async function run(cleared: ClearedRun, inputs: RunInputs, ports: RunPorts): Promise<RunResult> {
  // First, before any side effect: a run the gate did not clear, or a plan the parser did not make,
  // is refused, whatever its type says.
  assertCleared(cleared);
  assertBranded(cleared.plan);
  const { plan, target } = cleared;
  const startedAt = ports.clock.now();
  const preflight = checkPreflight({
    cleared, baseUrl: inputs.baseUrl, secretStore: ports.secrets, scriptSources: inputs.scriptSources ?? {},
    services: ports.services, databaseCommands: ports.databaseCommands,
  });
  const { redactor, logger } = runLogging(cleared, inputs.seed, ports, preflight.redaction);
  const nothingRan: NothingRanContext = { subject: cleared, ports, logger, determinismUnpinned: cannotPinDeterminism(ports.drivers, target) };
  const planned = lifecycle.plan(plan, target);
  // A log that fails this early ends the run Errored like one that fails later, once there are steps
  // to account for. It must not reject the run, and a refusal below still stands.
  const isPlanLogged = logKeepingTheResult({ kind: 'run.state', state: planned.state, targetId: target.id }, logger);
  if (!preflight.outcome.ok) {
    return refuseRun(planned, preflight.outcome.error, nothingRan, startedAt);
  }
  const passed = preflight.outcome.value;
  const context = runContext(cleared, inputs, passed, { ...nothingRan, redactor });

  const opened = await openSession(planned, context);
  if (!opened.ok) {
    const unavailable = lifecycle.targetUnavailable(planned, opened.error);
    return unavailableResult(target.id, unavailable.unavailable, nothingRan, startedAt);
  }
  const { session, driver } = opened.value;
  const stepContext: SessionContext = { ...context, session };
  const manifestInputs = manifestInputsOf(context, passed, opened.value);
  const manifestBeforeTheSteps = buildManifest(manifestInputs);
  const resolved = lifecycle.resolve(planned, session, manifestBeforeTheSteps, manifestHash(manifestBeforeTheSteps));
  const ran = await runTheSteps(stepContext, resolved, driver.info.id, isPlanLogged);
  const verdict = withRefusedDecisions(ran, session, logger);
  const after = await afterTheVerdict(stepContext, verdict);
  const manifest = ran.rewrites.length === 0 ? verdict.finished.manifest : buildManifest({ ...manifestInputs, responseRewrites: ran.rewrites });
  return seal({
    state: after.endState.state, targetId: target.id, manifest, manifestHash: manifestHash(manifest),
    steps: verdict.steps, blockedOrigins: after.blocked, unavailable: null, ...(verdict.finished.state === 'Denied' ? { denial: verdict.finished.denial } : {}),
    ...(after.cleanup === undefined ? {} : { cleanup: after.cleanup }), ...(after.reviewItems.length === 0 ? {} : { reviewItems: after.reviewItems }),
    ...(ran.stubAnswers.length === 0 ? {} : { stubAnswers: [...ran.stubAnswers] }),
    timings: { totalMilliseconds: readKeepingTheResult(() => ports.clock.now() - startedAt, 0, logger), stepMilliseconds: ran.stepMilliseconds },
  }, nothingRan);
}

type ManifestInputs = Parameters<typeof buildManifest>[0];

// What the manifest records of a run whose session opened, before any step runs.
function manifestInputsOf(context: RunContext, passed: PreflightPassed, opened: OpenedSession): ManifestInputs {
  const { plan, project, target } = context.cleared;
  const { inputs } = context;
  const unsafe = unsafeFeatureRecord(plan, project, passed.scripts);
  // A database command's output, and the database it ran against, cannot be pinned.
  const unpinned = [...opened.unpinned, ...(runsDatabaseCommands(plan) ? [DATABASE_COMMANDS_INPUT] : [])];
  return {
    plan, target, adapter: opened.driver.info, browser: opened.session.browser,
    seed: inputs.seed, fixedTimeMilliseconds: inputs.fixedTimeMilliseconds, fixtures: inputs.fixtures, host: inputs.host,
    ...secretRecords(context.secrets), callsServices: callsServices(plan),
    ...(unsafe === undefined ? {} : { unsafe }),
    ...(unpinned.length === 0 ? {} : { unpinned }),
    ...(opened.executableSha256 === undefined ? {} : { executableSha256: opened.executableSha256 }),
    ...(inputs.pins === undefined ? {} : { pins: { pins: inputs.pins, project } }),
    recordsReplies: project.replay?.recordReplies === true,
  };
}

type FinishedRun = lifecycle.Finished<'Passed' | 'Failed' | 'Errored'> | lifecycle.DeniedRun;

// The steps' results and verdict, and what was read from the session before it closed.
type StepsRun = {
  readonly running: lifecycle.Running;
  readonly steps: readonly StepResult[];
  readonly stepMilliseconds: readonly number[];
  readonly stubAnswers: readonly StubAnswer[];
  readonly rewrites: readonly AppliedRewrite[];
  readonly finished: FinishedRun;
};

// Runs the steps in order and gives them a verdict, then closes the session, whatever happened.
async function runTheSteps(context: SessionContext, resolved: lifecycle.Resolved, adapter: string, isPlanLogged: boolean): Promise<StepsRun> {
  const { session, logger, ports } = context;
  const targetId = context.cleared.target.id;
  const running = lifecycle.start(resolved);
  const steps: StepResult[] = [];
  const stepMilliseconds: number[] = [];
  let stubAnswers: readonly StubAnswer[];
  let rewrites: readonly AppliedRewrite[];
  let finished: FinishedRun;
  try {
    if (!isPlanLogged) {
      throw new Error('the log could not be written');
    }
    // The hash as it stands before the steps: a run whose proxy then rewrites a response ends with another.
    logger.log({ kind: 'run.state', state: resolved.state, targetId, adapter, sha256: resolved.manifestHash });
    logger.log({ kind: 'run.state', state: running.state, targetId });
    await runEachStep(context, steps, stepMilliseconds);
    // In the try: a port that cannot say what it rewrote must not leave a mutated run reading as plain.
    rewrites = ports.rewritesApplied?.() ?? [];
    finished = verdictOf(steps, running, context);
  } catch {
    // A step's own failures never get here, so only the log or the clock can have failed. The result
    // still accounts for every step.
    pushUnfinishedSteps(context.planSteps, steps);
    finished = lifecycle.finish(running, 'Errored');
    rewrites = readKeepingTheResult(() => ports.rewritesApplied?.() ?? [], [], logger);
  } finally {
    // Read before the browser goes, with every answer the stubs gave.
    stubAnswers = readKeepingTheResult(() => session.network.stubAnswers(), [], logger);
    await closeKeepingTheResult(session, ports.clock, logger);
  }
  return { running, steps, stepMilliseconds, stubAnswers, rewrites, finished };
}

// Each step in order, with its result and duration pushed as it ends. After a failed step, every
// later one is skipped.
async function runEachStep(context: SessionContext, steps: StepResult[], stepMilliseconds: number[]): Promise<void> {
  const { session, logger, ports, planSteps } = context;
  const notObserved = await failureToObserveRequests(session, context);
  for (const [index, step] of planSteps.entries()) {
    if (steps.some((done) => done.outcome === 'failed')) { steps.push({ index, type: step.type, outcome: 'skipped' }); continue; }
    const stepStartedAt = ports.clock.now();
    logger.log({ kind: 'step.start', stepIndex: index, stepType: step.type });
    // The first step stands for what could not be started, so the result says why nothing ran.
    const done = index === 0 && notObserved !== undefined ? failedStep(step, index, notObserved) : await runStep(step, index, session, context);
    // With no later step to notice, a crash the last step did not report would go unseen.
    const isLastStep = index === planSteps.length - 1;
    const result = isLastStep && done.outcome === 'passed' && session.crashed() ? failedStep(step, index, TARGET_CRASHED) : done;
    stepMilliseconds.push(ports.clock.now() - stepStartedAt);
    steps.push(result);
    logger.log({
      kind: 'step.end', stepIndex: index, stepType: step.type, outcome: result.outcome,
      durationMilliseconds: stepMilliseconds[stepMilliseconds.length - 1] ?? 0, ...(result.code === undefined ? {} : { code: result.code }),
    });
  }
}

// A denied action failed its step, so every later step was skipped and nothing ran after it. A
// failed call, page script or database command could not set up or reach what the test needs, and
// a page script that threw, hung or gave no usable result, or a backend check whose call got no
// answer, could not check it, which is not a product failure.
function verdictOf(steps: readonly StepResult[], running: lifecycle.Running, context: RunContext): FinishedRun {
  const denial = context.denials[0];
  if (denial !== undefined && steps.some((done) => done.code === 'policy-denied')) {
    return lifecycle.deny(running, denial);
  }
  if (steps.some((done) => couldNotTest(done, context))) {
    return lifecycle.finish(running, 'Errored');
  }
  return lifecycle.finish(running, steps.every((done) => done.outcome === 'passed') ? 'Passed' : 'Failed');
}

// Adds to the steps the one that was running when the log or the clock failed, as failed, and every
// one after it, as skipped.
function pushUnfinishedSteps(planSteps: readonly RunStep[], steps: StepResult[]): void {
  const [unfinished, ...unreached] = planSteps.slice(steps.length);
  if (unfinished !== undefined) {
    steps.push(failedStep(unfinished, steps.length, ADAPTER_ERROR));
  }
  for (const step of unreached) {
    steps.push({ index: steps.length, type: step.type, outcome: 'skipped' });
  }
}

type StepsVerdict = Pick<StepsRun, 'running' | 'steps' | 'finished'>;

// Read once the session has closed, when no decision is left waiting for the browser's answer. With
// no later step to report one the browser refused after the last step ended, the last step stands
// for it, as it does for a crash it missed.
function withRefusedDecisions(ran: StepsRun, session: Session, logger: Logger): StepsVerdict {
  const refusedDecisions: readonly string[] = readKeepingTheResult(() => session.refusedRequestDecisions(), [], logger);
  for (const refusal of refusedDecisions) {
    logFailureAfterTheVerdict(ADAPTER_ERROR, refusal, logger);
  }
  if (refusedDecisions.length === 0 || ran.finished.state !== 'Passed') {
    return ran;
  }
  const lastIndex = ran.steps.length - 1;
  const steps = ran.steps.map((done, index) => (index === lastIndex ? { ...done, ...stepFailed(ADAPTER_ERROR) } : done));
  return { running: ran.running, steps, finished: lifecycle.finish(ran.running, 'Errored') };
}

type AfterTheVerdict = {
  readonly cleanup: readonly CleanupResult[] | undefined;
  readonly reviewItems: readonly RunReviewItem[];
  readonly blocked: readonly string[];
  readonly endState: FinishedRun;
};

// The plan's cleanup, whatever the outcome, then what the egress refused, which the result claims,
// and the run's last log entries.
async function afterTheVerdict(context: SessionContext, verdict: StepsVerdict): Promise<AfterTheVerdict> {
  const { plan } = context.cleared;
  // A failing cleanup step never changes the verdict; it raises a review item.
  const cleanup = plan.cleanup === undefined ? undefined : await runCleanup(plan.cleanup, plan.steps.length, context.calls, context.commands);
  const cleanupItems = (cleanup ?? []).flatMap((done): RunReviewItem[] => (done.outcome === 'failed' ? [{ code: 'cleanup-failed', cleanupIndex: done.index }] : []));
  const blockedRead = readBlockedOrigins(context.session);
  if (!blockedRead.ok) {
    logFailureAfterTheVerdict(EGRESS_UNREAD, blockedRead.error, context.logger);
  }
  const blocked = blockedRead.ok ? blockedRead.value : [];
  const reviewItems: readonly RunReviewItem[] = blockedRead.ok ? cleanupItems : [...cleanupItems, { code: EGRESS_UNREAD }];
  const endState = blockedRead.ok ? verdict.finished : lifecycle.finish(verdict.running, 'Errored');
  logTheEnd(context, blocked, endState);
  return { cleanup, reviewItems, blocked, endState };
}

// The connections that failed, the origins the egress refused and the state the run ended in.
function logTheEnd(context: SessionContext, blocked: readonly string[], endState: FinishedRun): void {
  const { session, logger } = context;
  readKeepingTheResult(() => {
    for (const { origin, message } of session.connectionFailures()) {
      logger.log({ kind: 'session.connection-failed', origin, detail: message });
    }
  }, undefined, logger);
  readKeepingTheResult(() => {
    for (const origin of blocked) logger.log({ kind: 'network.blocked', origin });
    logger.log({
      kind: 'run.state', state: endState.state, targetId: context.cleared.target.id,
      ...(endState.state === 'Denied' ? { code: endState.denial.rule, stepIndex: endState.denial.stepIndex } : {}),
    });
  }, undefined, logger);
}

// What the run logs and redacts with: the caller's redactor with the plan's secrets added.
function runLogging(subject: RunSubject, seed: number, ports: RunPorts, secrets: ResolvedSecrets): {
  readonly redactor: Redactor; readonly logger: Logger;
} {
  const runId = sha256(`${sha256(canonicalJson(subject.plan))}:${subject.targetId}:${seed}`).slice(0, 16);
  const redactor = withSecretRedaction(ports.redactor, secrets);
  return { redactor, logger: manifestLogger(ports.events, redactor, runId) };
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
    cleared, inputs, ports, logger, gate: policyGate({ project, events: ports.audit }), denials: [], redactor, secrets, planSteps: passed.steps,
    scripts: passed.scripts, isShortSecret, withoutSecrets, holdsSecret, secretFilledFields: new Map(), values, remembered, calls, commands,
    rememberedTexts, downloads: new Map(), activeStubs: new Set(), setupFailedInside: new Set(), determinismUnpinned: logging.determinismUnpinned,
  };
}

// The result of a target the gate gave no cleared run, since the plan or the project's matrix does
// not declare it: TargetUnavailable with not-declared, before any driver is asked. It is logged and
// sealed as any run that never opened its target is.
function targetNotDeclaredResult(notDeclared: TargetNotDeclared, seed: number, ports: RunPorts): RunResult {
  const startedAt = ports.clock.now();
  const { logger } = runLogging(notDeclared, seed, ports, secretsToRedact(notDeclared, ports.secrets, ports.databaseCommands));
  const target = notDeclared.project.matrix.find((candidate) => candidate.id === notDeclared.targetId);
  const nothingRan: NothingRanContext = {
    subject: notDeclared, ports, logger, determinismUnpinned: target !== undefined && cannotPinDeterminism(ports.drivers, target),
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
      // A new kind of clearance fails to compile here until it is handled.
      default: {
        const unhandled: never = clearance;
        return unhandled;
      }
    }
  }
  return results;
}

// A step the adapter threw on, or that a refused request decision spoilt: what it saw is unknown,
// which is not a product failure either. The code stands for the failure and its text stays out of
// the result, since it could hold page content or a secret.
const ADAPTER_ERROR = StepCode.AdapterError;
const TARGET_CRASHED = StepCode.TargetCrashed;
// The codes of a page script or a database command that could not give a result to check, in
// whatever step it ran, of a service call that got no answer, and of an adapter that threw: the run
// could not test, which is not a product failure.
const UNUSABLE_RESULT_CODES: readonly string[] = [
  StepCode.ScriptFailed, StepCode.ScriptTimeout, StepCode.ScriptResultInvalid, StepCode.ScriptResultTooLarge, ADAPTER_ERROR,
  ...COMMAND_ERROR_CODES, ...NO_ANSWER_CODES,
];

// True when a failed step means the run could not test, wherever in the plan the step stands.
const couldNotTest = (done: StepResult, context: RunContext): boolean =>
  done.outcome === 'failed'
  && (isSetupStepType(done.type) || UNUSABLE_RESULT_CODES.some((code) => code === done.code) || context.setupFailedInside.has(done.index));

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

const hasARefusedDecision = (context: SessionContext): boolean => context.session.refusedRequestDecisions().length > 0;

// The requests the plan checks are observed from its start, so what a page sends as it loads counts
// too. Gives the code for what stopped it, or undefined when nothing did.
async function failureToObserveRequests(session: Session, context: SessionContext): Promise<StepCode | undefined> {
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
async function runStep(step: RunStep, index: number, document: DocumentSession, context: SessionContext): Promise<StepResult> {
  const denialsBefore = context.denials.length;
  const result = await runStepOnLivePage(step, index, document, context);
  // The audit log holds this denial, so whatever the driver reported from the same moment must not
  // turn the verdict into an ordinary failure.
  if (context.denials.length > denialsBefore) {
    return failedStep(step, index, StepCode.PolicyDenied);
  }
  return withActiveStubs(step, result, context.activeStubs);
}

async function runStepOnLivePage(step: RunStep, index: number, document: DocumentSession, context: SessionContext): Promise<StepResult> {
  if (document.crashed()) {
    return failedStep(step, index, TARGET_CRASHED);
  }
  const openingsBefore = document.unsupportedOpenings();
  // The steps inside a container report under the container's own index.
  const runInnerSteps: RunInnerSteps = (container, inner) => runStepsInside(container, index, inner, context);
  try {
    const done: StepResult = { index, type: step.type, ...(await executeStep(step, { ...context, index, document, runInnerSteps })) };
    // A request the browser would not let go on stays held, so neither a pass nor a failure of this
    // step says anything about the app: the run could not test. The reason goes to the log at the end.
    if (hasARefusedDecision(context)) {
      return { ...done, ...stepFailed(ADAPTER_ERROR) };
    }
    if (done.outcome !== StepOutcome.Passed) {
      return done;
    }
    if (isAssertionStepType(step.type) && document.crashed()) {
      return failedStep(step, index, TARGET_CRASHED);
    }
    // A popup or a download that no step asked for fails the step under way, so a run cannot pass as
    // if nothing had opened.
    return document.unsupportedOpenings() > openingsBefore ? failedStep(step, index, StepCode.UnsupportedStep) : done;
  } catch (error) {
    return failedStep(step, index, codeForThrow(error, document, context.logger));
  }
}

// True when a passed step left something beyond its outcome for a person to read.
const holdsARecord = (done: StepResult): boolean => Object.keys(done).some((key) => key !== 'index' && key !== 'type' && key !== 'outcome');

// The steps of a frame or newTab step, in order, in the document they stand in. They have no results
// of their own in the plan's list: the first that fails fails the frame or newTab step, with its code,
// observation and records, and the records of those before it are kept beside them.
async function runStepsInside(container: ContainerRunStep, index: number, document: DocumentSession, context: SessionContext): Promise<StepResult> {
  const kept: StepResult[] = [];
  const withKept = (result: StepResult, nested: readonly StepResult[] = []): StepResult =>
    (kept.length + nested.length === 0 ? result : { ...result, innerSteps: [...kept, ...nested] });
  for (const inner of container.steps) {
    const done = await runStep(inner, index, document, context);
    if (done.outcome !== StepOutcome.Passed) {
      if (isSetupStepType(inner.type)) {
        context.setupFailedInside.add(index);
      }
      return withKept({ ...done, type: container.type }, done.innerSteps);
    }
    if (holdsARecord(done)) {
      kept.push(done);
    }
  }
  return withKept({ index, type: container.type, outcome: StepOutcome.Passed });
}

// An assertion's result with the stubs active while it ran, so a report can tell a check of a faked
// answer from a check of the real backend. A stub step never checks anything, so the stubs active
// as the step ends are the ones active while it ran.
function withActiveStubs(step: Step, result: StepResult, activeStubs: ReadonlySet<StubName>): StepResult {
  if (activeStubs.size === 0 || !isAssertionStepType(step.type)) return result;
  return { ...result, activeStubs: [...activeStubs].sort() };
}

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
  const { plan, project } = context.subject;
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
type SealContext = { readonly subject: RunSubject; readonly ports: RunPorts; readonly determinismUnpinned: boolean };
// What a run that ended before any step needs: the seal, and the log it ends on.
type NothingRanContext = SealContext & { readonly logger: Logger };

// Adds the run mode, the guarantee statement, the unsafe label (for a plan using unsafe features),
// the approval label (for an approved plan) and the result's two hashes.
function seal(outcome: Omit<RunResult, 'resultHash' | 'evidenceHash' | 'approvalLabel' | 'mode' | 'guarantees' | 'unsafeFeatures'>, context: SealContext): RunResult {
  const standing = context.subject.standing;
  const unsafeFeatures = unsafeFeaturesOf(context.subject.plan);
  const isEgressUnread = (outcome.reviewItems ?? []).some((item) => item.code === EGRESS_UNREAD);
  const labelled = {
    ...outcome, mode: 'plan' as const, guarantees: planRunGuarantees(context, unsafeFeatures, isEgressUnread),
    ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
  };
  return withRunHashes(standing.mode === 'approved' ? { ...labelled, approvalLabel: approvalLabel(standing.approval) } : labelled);
}
