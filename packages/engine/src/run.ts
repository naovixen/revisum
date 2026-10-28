// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a parsed
// Plan, walks the typed lifecycle, never substitutes a target, and hashes everything except
// wall-clock timings.
import type {
  A11yFinding, ApprovalLabel, ArtifactReference, ArtifactStore, BrowserDriver, Clock, ElementProbe, Plan, Redactor, Result,
  Session, Step, Target, TargetId, Unavailable,
} from '@revisum/contracts';
import { approvalLabel, type PlanStanding } from './approval/plan-standing.ts';
import { canonicalJson, sha256 } from './hashing.ts';
import * as lifecycle from './lifecycle.ts';
import { manifestLogger, type Logger, type RunEventSink } from './logging.ts';
import { buildManifest, manifestHash, type FixtureReference, type HostInfo, type RunManifest } from './manifest.ts';
import { checkElement, checkPage, normalise, type Verdict } from './oracle.ts';
import type { PlanError } from './plan/plan-decoders.ts';
import { assertBranded } from './plan/plan-parser.ts';
import type { Project } from './project/project-parser.ts';
import { SENSITIVE_PLACEHOLDER } from './redaction.ts';

export type RunInputs = {
  readonly plan: Plan;
  readonly project: Project;
  readonly targetId: TargetId;
  readonly baseUrl: string;
  readonly seed: number;
  readonly fixedTimeMilliseconds: number;
  readonly fixtures: readonly FixtureReference[];
  readonly host: HostInfo;
  // The plan's standing (planStanding). Absent means no approval was supplied, so the run is a
  // proposal: it never reaches the project's production origins.
  readonly standing?: PlanStanding;
};

export type RunPorts = {
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  readonly clock: Clock;
  readonly artifacts: ArtifactStore;
  readonly redactor: Redactor;
  readonly events: RunEventSink;
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
};

export type RunResult = {
  readonly state: lifecycle.TerminalState;
  readonly targetId: string;
  readonly manifest: RunManifest | null;
  readonly manifestHash: string | null;
  readonly steps: readonly StepResult[];
  readonly blockedOrigins: readonly string[];
  readonly unavailable: Unavailable | null;
  // Present when the run was refused before any driver call.
  readonly refusal?: lifecycle.Refusal;
  // Present when the plan is approved: what the result says about that approval.
  readonly approvalLabel?: ApprovalLabel;
  // Hash of everything above except the manifest body, which its own hash covers. Timings are excluded.
  readonly resultHash: string;
  readonly timings: { readonly totalMilliseconds: number; readonly stepMilliseconds: readonly number[] };
};

export type Rejected = { readonly state: 'Rejected'; readonly errors: readonly PlanError[] };

type RunContext = { readonly inputs: RunInputs; readonly ports: RunPorts; readonly logger: Logger };

const POLL_INTERVAL_MILLISECONDS = 50;

export async function run(inputs: RunInputs, ports: RunPorts): Promise<RunResult> {
  // First, before any side effect: a plan the parser did not make is refused, whatever its type says.
  assertBranded(inputs.plan);
  const startedAt = ports.clock.now();
  const target = inputs.project.matrix.find((candidate) => candidate.id === inputs.targetId);
  const declared = target !== undefined && inputs.plan.targets.includes(inputs.targetId);
  const runId = sha256(`${sha256(canonicalJson(inputs.plan))}:${inputs.targetId}:${inputs.seed}`).slice(0, 16);
  const logger = manifestLogger(ports.events, ports.redactor, runId);
  const context: RunContext = { inputs, ports, logger };

  if (target === undefined || !declared) {
    return unavailableResult(inputs.targetId, { reason: 'not-declared', detail: 'target is not in both the plan and the matrix' }, context, startedAt);
  }
  const planned = lifecycle.plan(inputs.plan, target);
  logger.log({ kind: 'run.state', state: planned.state, targetId: target.id });

  // A proposal is refused before any driver call if it would reach a production origin.
  const productionOrigin = inputs.standing?.mode === 'approved' ? undefined : productionOriginReached(inputs);
  if (productionOrigin !== undefined) {
    const refused = lifecycle.refuse(planned, { code: 'origin_not_allowed', origin: productionOrigin });
    logger.log({ kind: 'run.state', state: refused.state, targetId: target.id, code: refused.refusal.code, origin: productionOrigin });
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
  const { session, driver } = opened.value;
  const manifest = buildManifest({
    plan: inputs.plan, target, adapter: driver.info, browser: session.browser,
    seed: inputs.seed, fixedTimeMilliseconds: inputs.fixedTimeMilliseconds, fixtures: inputs.fixtures, host: inputs.host,
  });
  const resolved = lifecycle.resolve(planned, session, manifest, manifestHash(manifest));
  logger.log({ kind: 'run.state', state: resolved.state, targetId: target.id, adapter: driver.info.id, sha256: resolved.manifestHash });

  const running = lifecycle.start(resolved);
  logger.log({ kind: 'run.state', state: running.state, targetId: target.id });
  const steps: StepResult[] = [];
  const stepMilliseconds: number[] = [];
  let finished: lifecycle.Finished<'Passed' | 'Failed' | 'Errored'>;
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
    finished = lifecycle.finish(running, steps.every((done) => done.outcome === 'passed') ? 'Passed' : 'Failed');
  } catch (error) {
    logger.log({ kind: 'step.end', outcome: 'failed', code: 'adapter-error', detail: errorText(error) });
    finished = lifecycle.finish(running, 'Errored');
  } finally {
    await session.close();
  }
  const blocked = [...new Set(session.blockedOrigins())].sort();
  for (const origin of blocked) logger.log({ kind: 'network.blocked', origin });
  logger.log({ kind: 'run.state', state: finished.state, targetId: target.id });
  return seal({
    state: finished.state, targetId: target.id, manifest, manifestHash: finished.manifestHash,
    steps, blockedOrigins: blocked, unavailable: null,
    timings: { totalMilliseconds: ports.clock.now() - startedAt, stepMilliseconds },
  }, inputs);
}

// The only entry point for untrusted input, such as a plan an AI proposed. Parsing happens first;
// on any error no driver method is called.
export async function runUntrusted(
  input: unknown,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
  base: Omit<RunInputs, 'plan' | 'targetId'>,
  ports: RunPorts,
): Promise<Rejected | readonly RunResult[]> {
  const parsed = parsePlan(input);
  if (!parsed.ok) return { state: 'Rejected', errors: parsed.error };
  const results: RunResult[] = [];
  for (const targetId of parsed.value.targets) results.push(await run({ ...base, plan: parsed.value, targetId }, ports));
  return results;
}

// The first production origin the run would reach: its base URL or a navigate step, inside frames too.
function productionOriginReached(inputs: RunInputs): string | undefined {
  const production = new Set<string>(inputs.project.productionOrigins);
  if (production.size === 0) return undefined;
  const origins = [new URL(inputs.baseUrl).origin];
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if (step.type === 'navigate') origins.push(new URL(step.url, inputs.baseUrl).origin);
      if (step.type === 'frame') visit(step.steps);
    }
  };
  visit(inputs.plan.steps);
  return origins.find((origin) => production.has(origin));
}

// The origins the browser may reach. A proposal never reaches a production origin, so they are
// left out of its allow-list as well, and any request the page makes to one is blocked.
function reachableOrigins(inputs: RunInputs): readonly string[] {
  if (inputs.standing?.mode === 'approved') return inputs.project.origins;
  const production = new Set<string>(inputs.project.productionOrigins);
  return inputs.project.origins.filter((origin) => !production.has(origin));
}

async function openSession(planned: lifecycle.Planned, context: RunContext): Promise<Result<{ session: Session; driver: BrowserDriver }, Unavailable>> {
  const driver = context.ports.drivers.get(planned.target.adapter);
  if (driver === undefined) return { ok: false, error: { reason: 'adapter-not-registered', detail: `no adapter '${planned.target.adapter}'` } };
  const supported = driver.supports(planned.target);
  if (!supported.ok) return supported;
  const opened = await driver.open(planned.target, {
    baseUrl: context.inputs.baseUrl,
    allowedOrigins: reachableOrigins(context.inputs),
    seed: context.inputs.seed,
    fixedTimeMilliseconds: context.inputs.fixedTimeMilliseconds,
    sensitiveSelectors: context.ports.redactor.selectors,
    timeoutMilliseconds: context.inputs.project.limits.stepTimeoutMilliseconds,
  });
  return opened.ok ? { ok: true, value: { session: opened.value, driver } } : opened;
}

// Assertion kinds the drivers' element probe cannot decide yet: it reports no checked or focused state.
const UNSUPPORTED_ASSERTION_KINDS: readonly string[] = ['checked', 'unchecked', 'focused'];

// Steps the plan language has but no driver performs yet. Each fails with unsupported-step, never
// passes or is skipped, so a plan that relies on one cannot report a pass it did not earn.
function isUnsupported(step: Step): boolean {
  switch (step.type) {
    case 'hover': case 'select': case 'upload': case 'frame': case 'dialog': return true;
    // A secret reference needs the secret store, which the run does not have yet.
    case 'fill': return typeof step.value !== 'string';
    case 'expect': return UNSUPPORTED_ASSERTION_KINDS.includes(step.assert.kind);
    default: return false;
  }
}

async function executeStep(step: Step, index: number, session: Session, target: Target, context: RunContext): Promise<StepResult> {
  const base = { index, type: step.type } as const;
  if (isUnsupported(step)) return { ...base, outcome: 'failed', code: 'unsupported-step' };
  switch (step.type) {
    case 'navigate': {
      const url = new URL(step.url, context.inputs.baseUrl);
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
      const acted = await session.act(step);
      return acted.ok ? { ...base, outcome: 'passed' } : { ...base, outcome: 'failed', code: acted.error.code };
    }
    case 'frame':
    case 'dialog':
      return { ...base, outcome: 'failed', code: 'unsupported-step' };
    case 'expect': {
      let last: ElementProbe | null = null;
      const verdict = await poll(context, async () => {
        last = await session.probe(step.locator);
        return checkElement(step.assert, last);
      });
      return verdict.pass
        ? { ...base, outcome: 'passed' }
        : { ...base, outcome: 'failed', code: verdict.code ?? 'assertion-failed', observed: observe(last, context.ports.redactor) };
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
        : { ...base, outcome: 'failed', code: 'assertion-failed', observed: context.ports.redactor.text(title) };
    }
    case 'a11yAudit': {
      const findings = [...(await session.audit())].sort((left, right) => (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
      context.logger.log({ kind: 'audit', stepIndex: index, findings: findings.length });
      const gateFails = step.mode === 'gate' && findings.length > 0;
      return { ...base, outcome: gateFails ? 'failed' : 'passed', findings, ...(gateFails ? { code: 'a11y-violations' } : {}) };
    }
    case 'capture': {
      const png = await session.screenshot(context.ports.redactor.selectors);
      const reference = await context.ports.artifacts.put(`${target.id}/${step.name}.png`, png, 'image/png');
      context.logger.log({ kind: 'artifact', stepIndex: index, artifact: reference.name, sha256: reference.sha256 });
      return { ...base, outcome: 'passed', artifact: reference };
    }
  }
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

// What a failed check saw, redacted: never the text of a sensitive element.
function observe(probe: ElementProbe | null, redactor: Redactor): string {
  if (probe === null || probe.count === 0) return '(no element)';
  if (probe.count > 1) return `(${probe.count} elements)`;
  if (probe.sensitive) return SENSITIVE_PLACEHOLDER;
  return redactor.text(normalise(probe.value ?? probe.text)).slice(0, 200);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function unavailableResult(targetId: string, unavailable: Unavailable, context: RunContext, startedAt: number): RunResult {
  context.logger.log({ kind: 'run.state', state: 'TargetUnavailable', targetId, code: unavailable.reason });
  return seal({
    state: 'TargetUnavailable', targetId, manifest: null, manifestHash: null, steps: [], blockedOrigins: [],
    unavailable, timings: { totalMilliseconds: context.ports.clock.now() - startedAt, stepMilliseconds: [] },
  }, context.inputs);
}

// Adds the approval label (for an approved plan) and the result hash.
function seal(outcome: Omit<RunResult, 'resultHash' | 'approvalLabel'>, inputs: RunInputs): RunResult {
  const standing = inputs.standing;
  const result = standing?.mode === 'approved' ? { ...outcome, approvalLabel: approvalLabel(standing.approval) } : outcome;
  const { timings: _excluded, manifest: _coveredByHash, ...hashed } = result;
  return { ...result, resultHash: sha256(canonicalJson(hashed)) };
}
