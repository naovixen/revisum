// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome.
// See docs/specs/SPEC-32-declared-service-calls.md for calls.
import {
  needsDriverFeatures,
  type A11yFinding, type ActionGuard, type ApprovalLabel, type ArtifactReference, type ArtifactStore, type Authorised,
  type BrowserDriver, type Clock, type LockEntry, type DialogStep, type ElementProbe, type EventSink, type GuardVerdict, type Plan, type PolicyRuleId, type Redactor,
  type ResolvedElement, type Result, type SafeText, type SecretStore, type ServiceCaller, type Session, type Step, type Target, type TargetId,
  type Unavailable, type ValueName, type GuaranteeStatement, type RunMode, type SuiteFinding, type SuiteName, type SuitePass,
  type SuiteTestId, type SuiteTestResult, type UnsafeFeature,
} from '@revisum/contracts';
import { approvalLabel, ownStanding, type PlanStanding } from './approval/plan-standing.ts';
import { guaranteeStatement } from './guarantees.ts';
import { canonicalJson, sha256 } from './hashing.ts';
import * as lifecycle from './lifecycle.ts';
import { manifestLogger, type Logger, type RunEventSink } from './logging.ts';
import { buildManifest, manifestHash, unsafeFeatureRecord, type FixtureReference, type HostInfo, type RunManifest } from './manifest.ts';
import { checkElement, checkPage, normalise, type Verdict } from './oracle.ts';
import type { PlanError } from './plan/plan-decoders.ts';
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
  NO_SECRETS, resolvePlanSecrets, resolvedSecretStore, secretRecords, shortSecretObservation, withSecretRedaction, type ResolvedSecrets,
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
};

// Something a run found that a person should look at, whatever the verdict: a cleanup call that
// failed, so test data may be left behind; or a suite test's criterion annotation whose
// description is not a valid criterion id, so it was dropped (never echoed).
export type RunReviewItem =
  | { readonly code: 'cleanup-failed'; readonly cleanupIndex: number }
  | { readonly code: 'spec-ambiguous'; readonly testId: SuiteTestId; readonly annotationIndex: number };

// What only an evidence run records: which pass it was, the suite command's exit code, and whether
// that code disagreed with the outcomes the report gives, which makes the run Errored.
export type EvidenceRunRecord = { readonly pass: SuitePass; readonly exitCode: number; readonly exitCodeMismatch: boolean };

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
  // The run's values by name: the plan's generated values, and the response fields calls remember.
  readonly values: Map<ValueName, SafeText>;
  // What the call steps use, when the run has a service caller.
  readonly calls: CallStepContext | undefined;
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
  let finished: lifecycle.Finished<'Passed' | 'Failed' | 'Errored'> | lifecycle.DeniedRun;
  try {
    for (const [index, step] of inputs.plan.steps.entries()) {
      if (steps.some((done) => done.outcome === 'failed')) { steps.push({ index, type: step.type, outcome: 'skipped' }); continue; }
      const stepStartedAt = ports.clock.now();
      logger.log({ kind: 'step.start', stepIndex: index, stepType: step.type });
      const result = await executeStep(step, index, session, target, context);
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
  });
  return opened.ok ? { ok: true, value: { session: opened.value, driver, unpinned } } : opened;
}

// Steps the plan language has but no driver performs yet. Each fails with unsupported-step, never
// passes or is skipped, and nothing of it reaches the driver, so a plan that relies on one cannot
// report a pass it did not earn or act in part.
function isUnsupported(step: Step): boolean {
  switch (step.type) {
    case 'hover': case 'select': case 'upload': case 'frame': case 'remember': return true;
    // Database commands run in a workload container, which comes with the isolated runner
    // (docs/specs/SPEC-36-unsafe-plan-features.md).
    case 'database': case 'expectDatabase': return true;
    // The features a step may need that no driver has yet are decided in one place, in contracts.
    default: return needsDriverFeatures(step);
  }
}

// What the runtime guard is given for a step that acts on no element.
const NO_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

async function executeStep(step: Step, index: number, session: Session, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  if (isUnsupported(step)) return { ...base, outcome: 'failed', code: 'unsupported-step' };
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
      const navigated = await session.navigate(url.href);
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
      const secret = resolved.type === 'fill' && typeof resolved.value !== 'string' ? context.secrets.fills.get(resolved.value.secretName) : undefined;
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
    case 'frame':
    case 'remember':
    case 'download':
    case 'expectDownload':
    case 'newTab':
    // The driver's network and storage ports come with the CDP driver; isUnsupported refused these above.
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage':
    // The driver's clock and clipboard ports come with the CDP driver; isUnsupported refused these
    // above, so an advance never becomes a real wait.
    case 'advanceClock': case 'expectClipboard':
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
      const verdict = await poll(context, async () => {
        last = await session.probe(locator.value);
        return checkElement(assertion.value, last);
      });
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, outcome: 'failed', code: verdict.code ?? 'assertion-failed', observed: observe(last, context, context.secretFilledFields.has(canonicalJson(locator.value))) };
    }
    case 'expectPage': {
      let title = '';
      const verdict = await poll(context, async () => {
        const page = await session.page();
        title = page.title;
        return checkPage(step.assert, page);
      });
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

// Repeats a check until it passes or the step timeout runs out.
async function poll(context: RunContext, check: () => Promise<Verdict>): Promise<Verdict> {
  const deadline = context.ports.clock.now() + context.inputs.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    const verdict = await check();
    if (verdict.pass || context.ports.clock.now() >= deadline) return verdict;
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
  return context.redactor.text(seen).slice(0, 200);
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
