// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports.
// See docs/specs/SPEC-32-declared-service-calls.md for calls,
// docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md for stubs, checks and storage and
// docs/specs/SPEC-34-clock-advance-and-clipboard.md for the clock and the clipboard.
import {
  needsDriverFeatures,
  type A11yFinding, type ActionGuard, type ApprovalLabel, type ArtifactReference, type ArtifactStore, type Authorised,
  type BrowserDriver, type Clock, type DocumentSession, type DownloadedFile, type DownloadName, type DriverFeature, type LockEntry, type DialogStep, type ElementProbe,
  type EventSink, type GuardVerdict, type PageAssertion, type Plan, type PolicyRuleId, type Redactor,
  type DownloadStep, type ResolvedElement, type Result, type SafeText, type SecretStore, type ServiceCaller, type Session, type Step, type Target, type TargetId,
  type Unavailable, type ValueName, type GuaranteeStatement, type RunMode, type SuiteFinding, type SuiteName, type SuitePass,
  type StubAnswer, type StubName, type SuiteTestId, type SuiteTestResult, type UnsafeFeature,
} from '@revisum/contracts';
import { approvalLabel, ownStanding, type PlanStanding } from './approval/plan-standing.ts';
import { totalClockAdvanceMilliseconds } from './clock-advance.ts';
import { advanceClock, checkClipboard, rememberFromClipboard, type ClockAndClipboardContext } from './clock-and-clipboard-steps.ts';
import { guaranteeStatement } from './guarantees.ts';
import { canonicalJson, sha256 } from './hashing.ts';
import * as lifecycle from './lifecycle.ts';
import { manifestLogger, type Logger, type RunEventSink } from './logging.ts';
import {
  checkRequests, checkResponse, checkStorage, observedRequestNames, rememberFromResponse, resetRequests, runStubStep, startObserving, writeStorage,
  type NetworkStepContext,
} from './network-and-storage/network-and-storage-steps.ts';
import { buildManifest, manifestHash, unsafeFeatureRecord, type FixtureReference, type HostInfo, type RunManifest } from './manifest.ts';
import { checkElement, checkPage, normalise, type Verdict } from './oracle.ts';
import type { SuiteDecodeError } from './evidence/suite-report.ts';
import { runTimeText, type PlanError } from './plan/plan-decoders.ts';
import { ASSERTION_STEP_TYPES } from './plan/plan-grammar.ts';
import { assertBranded } from './plan/plan-parser.ts';
import { unsafeFeaturesOf } from './plan/unsafe-features.ts';
import { assertAuthorised, policyGate, type PolicyGate } from './policy/policy-gate.ts';
import type { Project } from './project/project-parser.ts';
import { declaredCommands } from './project/unsafe-feature-declarations.ts';
import { SENSITIVE_PLACEHOLDER } from './redaction.ts';
import { withResultHash } from './result-hash.ts';
import {
  generateRunValues, resolveActionStep, resolveElementAssertion, resolveLocator, resolvePathTemplate, resolvePlanClock, resolveText,
} from './run-values.ts';
import {
  NO_SECRETS, resolvePlanSecrets, resolvedSecretStore, secretRecords, shortSecretObservation, stubAndStorageSecretStore, withSecretRedaction,
  type ResolvedSecrets,
} from './secrets/secret-resolution.ts';
import { SECRET_PLACEHOLDER } from './secrets/secret-values.ts';
import { adapterRegistry } from './target/adapter-registry.ts';
import { BROWSER_BUILD_INPUT, checkPinnedBuild } from './target/target-lock.ts';
import {
  runBackendCheck, runCallStep, runCleanup, type CallStepContext, type CleanupResult, type ServiceCallRecord,
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
  // A remember step's record: the value's name and the sha256 of its text, never the text.
  readonly remembered?: RememberedValueRecord;
  // A download step's record: the file's name, media type, size and sha256, never its content.
  readonly download?: DownloadRecord;
  // An assertion's record of the stubs active while it ran, sorted by name, so a report can say it
  // checked a faked answer and not the real backend. Absent when no stub was active.
  readonly activeStubs?: readonly StubName[];
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
  | { readonly code: 'expected-failure'; readonly testId: SuiteTestId };

// Why an evidence run ended as it did, beyond its tests' outcomes.
//   vacuous: the report holds no tests, so the run checked nothing and ends Failed.
//   suite-timeout: the suite ran past its timeout and was stopped; the run ends Errored.
//   setup-failed: the suite's setup command failed or timed out, so the suite never ran; Errored.
//   suite-report-unread: the suite's report is missing or was refused (decodeErrors says why); Errored.
export type EvidenceOutcomeCode = 'vacuous' | 'suite-timeout' | 'setup-failed' | 'suite-report-unread';

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
  // Present when the recorded pages were audited (SPEC-10).
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
  // The fields, by their resolved locator as canonical JSON, whose last fill typed a secret. What a
  // check reads back from one is the secret, whatever its length, so it is never kept.
  readonly secretFilledFields: Set<string>;
  // The run's values by name: the plan's generated values, the response fields calls remember and
  // the page texts remember steps read.
  readonly values: Map<ValueName, SafeText>;
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
  // The stubs started and not yet stopped.
  readonly activeStubs: Set<StubName>;
};

const POLL_INTERVAL_MILLISECONDS = 50;

export async function run(given: RunInputs, ports: RunPorts): Promise<RunResult> {
  // First, before any side effect: a plan the parser did not make is refused, whatever its type says.
  assertBranded(given.plan);
  // A standing lent from another plan is dropped here, so production, the origin allow-list and
  // the approval label all see the plan as the proposal it is.
  const inputs: RunInputs = { ...given, standing: ownStanding(given.plan, given.standing) };
  const startedAt = ports.clock.now();
  const target = inputs.project.matrix.find((candidate) => candidate.id === inputs.targetId);
  const declared = target !== undefined && inputs.plan.targets.includes(inputs.targetId);
  const runId = sha256(`${sha256(canonicalJson(inputs.plan))}:${inputs.targetId}:${inputs.seed}`).slice(0, 16);
  // Resolving reads only the store, so it can come first: the run's redactor needs the secrets
  // before anything is logged. A missing secret refuses the run below, before any driver call.
  const resolution = resolvePlanSecrets(inputs.plan, ports.secrets, inputs.project.calls);
  const secrets = resolution.ok ? resolution.value : NO_SECRETS;
  const redactor = withSecretRedaction(ports.redactor, secrets);
  const logger = manifestLogger(ports.events, redactor, runId);
  const gate = policyGate({ project: inputs.project, events: ports.audit });
  // Generation is pure, so values exist before anything runs; a run with no target has none.
  const values = new Map<ValueName, SafeText>(target === undefined
    ? [] : generateRunValues(inputs.plan, inputs.seed, inputs.fixedTimeMilliseconds, target, inputs.project));
  const calls: CallStepContext | undefined = ports.services === undefined ? undefined : {
    caller: ports.services, project: inputs.project, values, secrets: resolvedSecretStore(secrets), clock: ports.clock, logger,
  };
  const context: RunContext = {
    inputs, ports, logger, gate, denials: [], redactor, secrets, isShortSecret: shortSecretObservation(secrets), secretFilledFields: new Set(), values, calls,
    rememberedTexts: new Set(), performs: [], session: null, downloads: new Map(), activeStubs: new Set(),
  };

  if (target === undefined || !declared) {
    return unavailableResult(inputs.targetId, { reason: 'not-declared', detail: 'target is not in both the plan and the matrix' }, context, startedAt);
  }
  // Before any side effect on the target: a plan the gate did not clear for it, under this very
  // project, is refused.
  assertAuthorised(inputs.plan, target.id, inputs.project);
  const planned = lifecycle.plan(inputs.plan, target);
  logger.log({ kind: 'run.state', state: planned.state, targetId: target.id });

  // Refused before any driver call if the run would reach a production origin it may not.
  const productionOrigin = productionAllowed(inputs) ? undefined : productionOriginReached(inputs);
  if (productionOrigin !== undefined) {
    const refused = lifecycle.refuse(planned, { code: 'origin_not_allowed', origin: productionOrigin });
    logger.log({ kind: 'run.state', state: refused.state, targetId: target.id, code: refused.refusal.code, origin: productionOrigin });
    return seal({
      state: refused.state, targetId: target.id, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
      unavailable: null, refusal: refused.refusal, timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds: [] },
    }, inputs);
  }

  if (!resolution.ok) {
    const refused = lifecycle.refuse(planned, { code: 'secret-missing', secretName: resolution.error });
    logger.log({
      kind: 'run.state', state: refused.state, targetId: target.id, code: refused.refusal.code,
      detail: `the secret store has no secret named ${resolution.error}`,
    });
    return seal({
      state: refused.state, targetId: target.id, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
      unavailable: null, refusal: refused.refusal, timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds: [] },
    }, inputs);
  }

  // Refused before any side effect when the plan names a page script whose source the run was not
  // given: the manifest could not record what would run.
  const unsafe = unsafeFeatureRecord(inputs.plan, inputs.project, inputs.scriptSources ?? {});
  if (!unsafe.ok) {
    const refused = lifecycle.refuse(planned, { code: 'script-source-missing', file: unsafe.error });
    logger.log({ kind: 'run.state', state: refused.state, targetId: target.id, code: refused.refusal.code });
    return seal({
      state: refused.state, targetId: target.id, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
      unavailable: null, refusal: refused.refusal, timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds: [] },
    }, inputs);
  }

  // Refused before any side effect when the plan calls a service and no caller was wired in.
  if (callsServices(inputs.plan) && calls === undefined) {
    const refused = lifecycle.refuse(planned, { code: 'services-unavailable' });
    logger.log({ kind: 'run.state', state: refused.state, targetId: target.id, code: refused.refusal.code });
    return seal({
      state: refused.state, targetId: target.id, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
      unavailable: null, refusal: refused.refusal, timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds: [] },
    }, inputs);
  }

  const opened = await openSession(planned, context);
  if (!opened.ok) {
    const unavailable = lifecycle.targetUnavailable(planned, opened.error);
    return unavailableResult(target.id, unavailable.unavailable, context, startedAt);
  }
  const { session, driver, unpinned } = opened.value;
  // From here on, a step needing an optional feature is refused only when this driver lacks it.
  const stepContext: RunContext = { ...context, performs: driver.info.performs ?? [], session };
  const manifest = buildManifest({
    plan: inputs.plan, target, adapter: driver.info, browser: session.browser,
    seed: inputs.seed, fixedTimeMilliseconds: inputs.fixedTimeMilliseconds, fixtures: inputs.fixtures, host: inputs.host,
    ...secretRecords(secrets), callsServices: callsServices(inputs.plan),
    ...(unsafe.value === undefined ? {} : { unsafe: unsafe.value }),
    ...(unpinned.length === 0 ? {} : { unpinned }),
  });
  const resolved = lifecycle.resolve(planned, session, manifest, manifestHash(manifest));
  logger.log({ kind: 'run.state', state: resolved.state, targetId: target.id, adapter: driver.info.id, sha256: resolved.manifestHash });

  const running = lifecycle.start(resolved);
  logger.log({ kind: 'run.state', state: running.state, targetId: target.id });
  const steps: StepResult[] = [];
  const stepMilliseconds: number[] = [];
  let stubAnswers: readonly StubAnswer[] = [];
  let finished: lifecycle.Finished<'Passed' | 'Failed' | 'Errored'> | lifecycle.DeniedRun;
  try {
    // The requests the plan checks are observed from its start, so what a page sends as it loads
    // counts too. A driver refused request checks observes nothing: those steps fail on their own.
    if (stepContext.performs.includes('requestChecks')) {
      const observing = await startObserving(observedRequestNames(inputs.plan), networkContext(stepContext));
      if (!observing.ok) throw new Error(`the requests the plan checks could not be observed: ${observing.error}`);
    }
    for (const [index, step] of inputs.plan.steps.entries()) {
      if (steps.some((done) => done.outcome === 'failed')) { steps.push({ index, type: step.type, outcome: 'skipped' }); continue; }
      const stepStartedAt = ports.clock.now();
      logger.log({ kind: 'step.start', stepIndex: index, stepType: step.type });
      const result = withActiveStubs(step, await executeStep(step, index, session, target, stepContext), context.activeStubs);
      stepMilliseconds.push(ports.clock.now() - stepStartedAt);
      steps.push(result);
      logger.log({
        kind: 'step.end', stepIndex: index, stepType: step.type, outcome: result.outcome,
        durationMilliseconds: stepMilliseconds[stepMilliseconds.length - 1] ?? 0, ...(result.code ? { code: result.code } : {}),
      });
    }
    // A denied action failed its step, so every later step was skipped and nothing ran after it.
    // A failed call, page script or database command could not set up or reach what the test
    // needs, which is not a product failure.
    const denial = context.denials[0];
    finished = denial !== undefined && steps.some((done) => done.code === 'policy-denied')
      ? lifecycle.deny(running, denial)
      : steps.some((done) => SETUP_STEP_TYPES.includes(done.type) && done.outcome === 'failed')
        ? lifecycle.finish(running, 'Errored')
        : lifecycle.finish(running, steps.every((done) => done.outcome === 'passed') ? 'Passed' : 'Failed');
  } catch (error) {
    logger.log({ kind: 'step.end', outcome: 'failed', code: 'adapter-error', detail: errorText(error) });
    finished = lifecycle.finish(running, 'Errored');
  } finally {
    // Read before the browser goes, with every answer the stubs gave.
    stubAnswers = session.network?.stubAnswers() ?? [];
    await session.close();
  }
  // Whatever the outcome. A failing cleanup step never changes the verdict; it raises a review item.
  const cleanup = inputs.plan.cleanup === undefined ? undefined : await runCleanup(inputs.plan.cleanup, inputs.plan.steps.length, calls);
  const reviewItems = (cleanup ?? []).flatMap((done): RunReviewItem[] => (done.outcome === 'failed' ? [{ code: 'cleanup-failed', cleanupIndex: done.index }] : []));
  const blocked = [...new Set(session.blockedOrigins())].sort();
  for (const origin of blocked) logger.log({ kind: 'network.blocked', origin });
  logger.log({
    kind: 'run.state', state: finished.state, targetId: target.id,
    ...(finished.state === 'Denied' ? { code: finished.denial.rule, stepIndex: finished.denial.stepIndex } : {}),
  });
  return seal({
    state: finished.state, targetId: target.id, manifest, manifestHash: finished.manifestHash,
    steps, blockedOrigins: blocked, unavailable: null, ...(finished.state === 'Denied' ? { denial: finished.denial } : {}),
    ...(cleanup === undefined ? {} : { cleanup }), ...(reviewItems.length === 0 ? {} : { reviewItems }),
    ...(stubAnswers.length === 0 ? {} : { stubAnswers: [...stubAnswers] }),
    timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds },
  }, inputs);
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

// True when the plan calls a declared service, in its steps or its cleanup.
const callsServices = (plan: Plan): boolean =>
  [...plan.steps, ...(plan.cleanup ?? [])].some((step) => step.type === 'call' || step.type === 'expectBackend');

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
};

// Resolves the target in order, stopping at the first "no": only the adapter the target names is
// asked, it is asked once, and nothing else is tried in its place. A pinned build is checked
// before anything launches. See docs/specs/SPEC-05-target-matrix-and-lock.md.
async function openSession(planned: lifecycle.Planned, context: RunContext): Promise<Result<OpenedSession, Unavailable>> {
  const driver = adapterRegistry(context.ports.drivers).find(planned.target.adapter);
  if (driver === null) return { ok: false, error: { reason: 'adapter-not-registered', detail: `no adapter '${planned.target.adapter}'` } };
  const supported = driver.supports(planned.target);
  if (!supported.ok) return supported;
  const lockEntries = context.inputs.lockEntries;
  const pinning = lockEntries === undefined ? undefined : await checkPinnedBuild(driver, planned.target, lockEntries);
  if (pinning !== undefined && !pinning.ok) return pinning;
  const unpinned = pinning?.value === 'unpinned' ? [BROWSER_BUILD_INPUT] : [];
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
  return opened.ok ? { ok: true, value: { session: opened.value, driver, unpinned } } : opened;
}

// Steps the plan language has but the run's driver does not perform. Each fails with
// unsupported-step, never passes or is skipped, and nothing of it reaches the driver, so a plan that
// relies on one cannot report a pass it did not earn or act in part. Hover, select and upload go
// to the driver, which refuses them the same way when it does not perform them; a frame step needs
// the driver's frame port.
function isUnsupported(step: Step, performs: readonly DriverFeature[]): boolean {
  switch (step.type) {
    // Database commands run in a workload container, which comes with the isolated runner
    // (docs/specs/SPEC-36-unsafe-plan-features.md).
    case 'database': case 'expectDatabase': return true;
    // What a step needs from a driver, and which of it is optional, is decided in one place, in
    // contracts; the driver declares the optional features it performs.
    default: return needsDriverFeatures(step, performs);
  }
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
  project: context.inputs.project, session: context.session, values: context.values, rememberedTexts: context.rememberedTexts,
  secrets: stubAndStorageSecretStore(context.secrets), clock: context.ports.clock, logger: context.logger, activeStubs: context.activeStubs,
});

// What the clock and clipboard steps use: the run's session and values.
const clockAndClipboardContext = (context: RunContext): ClockAndClipboardContext => ({
  project: context.inputs.project, session: context.session, values: context.values, rememberedTexts: context.rememberedTexts,
  clock: context.ports.clock, logger: context.logger,
});

// What the runtime guard is given for a step that acts on no element.
const NO_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

// Runs one step on a document of the page: the top document, or an iframe's for the steps inside a
// frame step, which report under the frame step's own index.
async function executeStep(step: Step, index: number, session: DocumentSession, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  if (isUnsupported(step, context.performs)) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  // No driver loads saved storage state into its session yet (that comes with the CDP driver's
  // session environment). A plan that names it relies on being signed in, so its first step fails
  // and nothing reaches the driver, rather than running without the state the plan declared.
  if (context.inputs.plan.storageState !== undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
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
        else context.secretFilledFields.add(canonicalJson(resolved.locator));
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
      // The frame's steps run in order inside the iframe's document. They have no results of their
      // own: the first that fails fails the frame step, with its code and observation.
      if (session.frame === undefined) return { ...base, outcome: 'failed', code: 'unsupported-step' };
      const locator = resolveLocator(step.locator, context.values, context.inputs.project);
      if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
      const entered = await session.frame(locator.value);
      if (!entered.ok) return { ...base, outcome: 'failed', code: entered.error.code };
      for (const inner of step.steps) {
        const done = await executeStep(inner, index, entered.value, target, context);
        if (done.outcome !== 'passed') return { ...done, type: step.type };
      }
      return { ...base, outcome: 'passed' };
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
    // isUnsupported refused them above otherwise, so an advance never becomes a real wait.
    case 'advanceClock': return { ...base, ...(await advanceClock(step, clockAndClipboardContext(context))) };
    case 'expectClipboard': return { ...base, ...(await checkClipboard(step, clockAndClipboardContext(context))) };
    // Page scripts need the driver's script port and database commands the workload runner;
    // isUnsupported refused these above, so nothing of them runs.
    case 'evaluate': case 'expectScript': case 'database': case 'expectDatabase':
      return { ...base, outcome: 'failed', code: 'unsupported-step' };
    case 'expect': {
      const locator = resolveLocator(step.locator, context.values, context.inputs.project);
      if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
      const assertion = resolveElementAssertion(step.assert, context.values, context.inputs.project);
      if (!assertion.ok) return { ...base, outcome: 'failed', code: assertion.error };
      let last: ElementProbe | null = null;
      const verdict = await poll(context, session, async () => {
        last = await session.probe(locator.value);
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
        : { ...base, outcome: 'failed', code: 'assertion-failed', observed: context.isShortSecret(title) ? SECRET_PLACEHOLDER : context.redactor.text(title) };
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
      const png = await session.screenshot(context.ports.redactor.selectors);
      const reference = await context.ports.artifacts.put(`${target.id}/${step.name}.png`, png, 'image/png');
      context.logger.log({ kind: 'artifact', stepIndex: index, artifact: reference.name, sha256: reference.sha256 });
      return { ...base, outcome: 'passed', artifact: reference };
    }
  }
}

// Reads a remember step's value from the page through the prober, waiting as a check waits until
// the locator matches one element with non-empty text (or input value), whitespace normalised.
// The text must be safe text no longer than the project's maximumTextLength. Only the value's name
// and sha256 are kept in the result and the events, never the text.
async function rememberFromPage(step: Extract<Step, { type: 'remember' }>, index: number, session: DocumentSession, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  const from = step.from;
  // isUnsupported refused every other source before the step got here.
  if (!('element' in from) || from.read === 'attribute') return { ...base, outcome: 'failed', code: 'unsupported-step' };
  const locator = resolveLocator(from.element, context.values, context.inputs.project);
  if (!locator.ok) return { ...base, outcome: 'failed', code: locator.error };
  const textOf = (probe: ElementProbe): string => normalise(from.read === 'value' ? probe.value ?? '' : probe.text);
  const seen: { probe: ElementProbe | null } = { probe: null };
  const verdict = await poll(context, session, async (): Promise<Verdict> => {
    const probe = await session.probe(locator.value);
    seen.probe = probe;
    if (probe.count === 0) return { pass: false, code: 'not-found' };
    if (probe.count > 1) return { pass: false, code: 'ambiguous' };
    return textOf(probe) === '' ? { pass: false, code: null } : { pass: true, code: null };
  });
  if (verdict.code === TARGET_CRASHED || verdict.code === 'not-found' || verdict.code === 'ambiguous') return { ...base, outcome: 'failed', code: verdict.code };
  const text = seen.probe === null ? '' : textOf(seen.probe);
  if (text === '') return { ...base, outcome: 'failed', code: 'value-empty' };
  const maximumLength = context.inputs.project.limits.maximumTextLength;
  if (text.length > maximumLength) return { ...base, outcome: 'failed', code: 'value-too-long' };
  const safe = runTimeText(text, maximumLength);
  if (safe === undefined) return { ...base, outcome: 'failed', code: 'value-unsafe' };
  context.values.set(step.name, safe);
  context.rememberedTexts.add(safe);
  const digest = sha256(safe);
  context.logger.log({ kind: 'value.remembered', stepIndex: index, valueName: step.name, sha256: digest });
  return { ...base, outcome: 'passed', remembered: { valueName: step.name, sha256: digest } };
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
// there in order and closes the tab, whatever they did. The steps have no results of their own:
// the first that fails fails the newTab step, with its code.
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
  try {
    for (const inner of step.steps) {
      const done = await executeStep(inner, index, tab, target, context);
      if (done.outcome !== 'passed') return { ...done, type: step.type };
    }
    return { ...base, outcome: 'passed' };
  } finally {
    await tab.close();
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
// wait at once: nothing on it can change any more.
async function poll(context: RunContext, session: DocumentSession, check: () => Promise<Verdict>): Promise<PollVerdict> {
  const crashed = (): boolean => session.crashed?.() === true;
  const deadline = context.ports.clock.now() + context.inputs.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    let verdict: Verdict;
    try {
      verdict = await check();
    } catch (error) {
      // A read that failed because the page died is the crash; any other failure is the adapter's.
      if (crashed()) return { pass: false, code: TARGET_CRASHED };
      throw error;
    }
    if (verdict.pass) return verdict;
    if (crashed()) return { pass: false, code: TARGET_CRASHED };
    if (context.ports.clock.now() >= deadline) return verdict;
    await context.ports.clock.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

// What a failed check saw, redacted: never the text of a sensitive element, nothing read from a
// field a secret was typed into, and no text that is a whole short secret.
function observe(probe: ElementProbe | null, context: RunContext, filledFromSecret: boolean): string {
  if (probe === null || probe.count === 0) return '(no element)';
  if (probe.count > 1) return `(${probe.count} elements)`;
  if (probe.sensitive) return SENSITIVE_PLACEHOLDER;
  const seen = normalise(probe.value ?? probe.text);
  if (filledFromSecret || context.isShortSecret(seen)) return SECRET_PLACEHOLDER;
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
  context.logger.log({ kind: 'run.state', state: 'TargetUnavailable', targetId, code: unavailable.reason });
  return seal({
    state: 'TargetUnavailable', targetId, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
    unavailable, timings: { totalMilliseconds: context.ports.clock.now() - startedAt, stepMilliseconds: [] },
  }, context.inputs);
}

// What a plan run vouches for: decided by the plan's unsafe features and the run's isolation alone,
// never by what the run happened to do, so two runs of one plan say the same. Until the isolated
// runner (SPEC-07) runs plans behind its egress proxy, a plan run runs on the host, so egress,
// credentials and replay are not claimed.
const planRunGuarantees = (unsafeFeatures: readonly UnsafeFeature[]): GuaranteeStatement =>
  guaranteeStatement({ mode: 'plan', egressEnforced: false, unmaskedScreenshotsKept: false, unsafeFeatures });

// Adds the run mode, the guarantee statement, the unsafe label (for a plan using unsafe features),
// the approval label (for an approved plan) and the result hash.
function seal(outcome: Omit<RunResult, 'resultHash' | 'approvalLabel' | 'mode' | 'guarantees' | 'unsafeFeatures'>, inputs: RunInputs): RunResult {
  const standing = inputs.standing;
  const unsafeFeatures = unsafeFeaturesOf(inputs.plan);
  const labelled = {
    ...outcome, mode: 'plan' as const, guarantees: planRunGuarantees(unsafeFeatures), ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
  };
  return withResultHash(standing?.mode === 'approved' ? { ...labelled, approvalLabel: approvalLabel(standing.approval) } : labelled);
}
