// The red-team set: plans that parse, yet would do harm. Each one must end Denied, and the step the
// gate denies must dispatch no input event. Each harmful plan has a benign twin that differs only
// in the harmful detail and runs to the end, so a gate that denied everything would fail too.
//
// The gate is wired into the CDP driver only in SPEC-06, so each plan runs here through a stand-in
// for the driver's act(): it asks the guard first, as the driver will, and dispatches an input
// event only when the guard allows. A static denial means the run never starts.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { policyGate, type Plan, type PolicyGate, type PolicyRuleId, type ResolvedElement, type Step, type TrustedProject } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import {
  OPEN_ACCOUNT_PAGE, NO_ELEMENT, ORIGIN, PRODUCTION_ORIGIN, UNLISTED_ORIGIN,
  click, element, localeOf, navigate, parsedPlan, planOf, policyProjectInput, role, targetsOf, testGate, trustedProject,
  type JsonRecord,
} from './policy-examples.ts';
import { memoryEventSink } from './approval-repositories.ts';

type PageView = { readonly element?: Partial<ResolvedElement>; readonly dialogText?: string };
type Variant = { readonly target?: string; readonly steps: readonly JsonRecord[]; readonly page?: Readonly<Record<string, PageView>> };
type RedTeamCase = {
  readonly name: string;
  readonly actionKind: 'click' | 'press' | 'navigate' | 'dialog' | 'unnamed-control';
  readonly stage: 'static' | 'runtime';
  readonly target: string;
  readonly deniedStep: number | null;
  readonly rule: PolicyRuleId;
  readonly harmful: Variant;
  readonly benign: Variant;
};

const RED_TEAM: readonly RedTeamCase[] =
  JSON.parse(readFileSync(join(FIXTURES, 'policy-red-team', 'cases.json'), 'utf8')).cases;

// The action kinds this spec guards, each of which needs at least one harmful plan.
const ACTION_KINDS: readonly RedTeamCase['actionKind'][] = ['click', 'press', 'navigate', 'dialog', 'unnamed-control'];

type Outcome =
  | { readonly state: 'Denied'; readonly stage: 'static' | 'runtime'; readonly rule: PolicyRuleId; readonly stepIndex: number | null; readonly inputEvents: readonly number[] }
  | { readonly state: 'Ran'; readonly inputEvents: readonly number[] };

// Steps a driver performs on the page. A navigate step is judged by the static check; assertions,
// captures and audits only read the page. A runtime denial ends the run Denied before the step's
// input event, as the driver will once SPEC-06 wires the guard in.
const ACTING_STEPS: readonly Step['type'][] = ['click', 'hover', 'fill', 'select', 'upload', 'press', 'dialog'];

// What the page resolves a step's locator to, unless the case says otherwise.
function resolvedElement(step: Step, seen: PageView | undefined): ResolvedElement {
  if (seen?.element !== undefined) return element(seen.element);
  if (step.type === 'dialog') return NO_ELEMENT;
  if (!('locator' in step)) throw new Error(`a ${step.type} step resolves no element`);
  const locator = step.locator;
  if (locator.by === 'role') return element({ role: locator.role, name: locator.name });
  if (locator.by === 'label') return element({ role: 'textbox', name: locator.label });
  if (locator.by === 'text') return element({ name: locator.text });
  throw new Error(`the case must say what test id ${locator.testId} resolves to`);
}

// Runs a plan through the gate as a run would: the static check first, then the guard before each
// acting step. An input event is dispatched only for a step the guard allowed.
function runThroughGate(gate: PolicyGate, project: TrustedProject, plan: Plan, targetId: string, page: Variant['page']): Outcome {
  const inputEvents = plan.steps.map(() => 0);
  const decision = gate.decide(plan, targetsOf(project, plan));
  if (decision.kind === 'deny') return { state: 'Denied', stage: 'static', rule: decision.rule, stepIndex: decision.stepIndex, inputEvents };
  const locale = localeOf(project, targetId);
  for (const [index, step] of decision.plan.steps.entries()) {
    if (!ACTING_STEPS.includes(step.type)) continue;
    const seen = page?.[String(index)];
    const verdict = gate.guardAction(step, index, resolvedElement(step, seen), seen?.dialogText ?? null, locale);
    if (verdict.kind === 'deny') return { state: 'Denied', stage: 'runtime', rule: verdict.rule, stepIndex: verdict.stepIndex, inputEvents };
    inputEvents[index] = (inputEvents[index] ?? 0) + 1;
  }
  return { state: 'Ran', inputEvents };
}

async function runVariant(variant: Variant, targetId: string): Promise<Outcome> {
  const { gate, project } = await testGate();
  return runThroughGate(gate, project, parsedPlan(planOf(variant.steps, [targetId])), targetId, variant.page);
}

test('the red-team set holds at least one harmful plan for every action kind the gate guards', { criterion: 'AC-SPEC-03-03' }, () => {
  const covered = new Set(RED_TEAM.map((redTeamCase) => redTeamCase.actionKind));
  assert.deepEqual(ACTION_KINDS.filter((kind) => !covered.has(kind)), []);
  assert.ok(RED_TEAM.some((redTeamCase) => redTeamCase.stage === 'static'), 'no case is caught by the static check');
  assert.ok(RED_TEAM.some((redTeamCase) => redTeamCase.stage === 'runtime'), 'no case is caught by the runtime guard');
});

for (const redTeamCase of RED_TEAM) {
  test(`a plan that ${redTeamCase.name} ends Denied as ${redTeamCase.rule}, with no input event for the denied step`, { criterion: 'AC-SPEC-03-03' }, async () => {
    const outcome = await runVariant(redTeamCase.harmful, redTeamCase.harmful.target ?? redTeamCase.target);
    assert.equal(outcome.state, 'Denied', JSON.stringify(outcome));
    if (outcome.state !== 'Denied') return;
    assert.equal(outcome.rule, redTeamCase.rule);
    assert.equal(outcome.stage, redTeamCase.stage, `expected the ${redTeamCase.stage} check to deny it`);
    if (redTeamCase.deniedStep !== null) {
      assert.equal(outcome.stepIndex, redTeamCase.deniedStep);
      assert.equal(outcome.inputEvents[redTeamCase.deniedStep], 0, 'the denied step dispatched an input event');
    }
    // Nothing runs after a denial, and a static denial runs nothing at all.
    const firstSilent = redTeamCase.stage === 'static' ? 0 : (redTeamCase.deniedStep ?? 0);
    assert.deepEqual(outcome.inputEvents.slice(firstSilent).filter((count) => count > 0), [], JSON.stringify(outcome.inputEvents));
  });

  test(`the benign twin of the plan that ${redTeamCase.name} runs to the end`, { criterion: 'AC-SPEC-03-03' }, async () => {
    const outcome = await runVariant(redTeamCase.benign, redTeamCase.benign.target ?? redTeamCase.target);
    assert.equal(outcome.state, 'Ran', JSON.stringify(outcome));
    const actingSteps = redTeamCase.benign.steps.filter((step) => ACTING_STEPS.includes(step['type'] as Step['type'])).length;
    assert.equal(outcome.inputEvents.reduce((total, count) => total + count, 0), actingSteps, 'not every acting step dispatched its input event');
  });
}

// ---- Plans valid for the parser's project, but not for the trusted one ---------------------------
// A plan is parsed against the project it was written for. The gate checks it again against the
// trusted project, so a plan parsed under looser settings is still held to the trusted ones.

async function decideAgainstTrusted(plan: Plan, trustedInput: JsonRecord) {
  const project = await trustedProject(trustedInput);
  const gate = policyGate({ project, events: memoryEventSink() });
  return gate.decide(plan, targetsOf(project, plan));
}

const LOOSE_ORIGINS = policyProjectInput({ origins: [ORIGIN, PRODUCTION_ORIGIN, UNLISTED_ORIGIN] });
const toUnlistedOrigin = () => parsedPlan(planOf([OPEN_ACCOUNT_PAGE, navigate(`${UNLISTED_ORIGIN}/admin`)]), LOOSE_ORIGINS);

test('a plan that navigates to an origin the trusted project does not declare ends Denied as undeclared-origin', { criterion: 'AC-SPEC-03-03' }, async () => {
  const decision = await decideAgainstTrusted(toUnlistedOrigin(), policyProjectInput());
  assert.deepEqual(decision, { kind: 'deny', rule: 'undeclared-origin', stepIndex: 1 });
});

test('the same plan is allowed by a trusted project that declares the origin', { criterion: 'AC-SPEC-03-03' }, async () => {
  const decision = await decideAgainstTrusted(toUnlistedOrigin(), LOOSE_ORIGINS);
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

const EIGHT_CLICKS = Array.from({ length: 8 }, (_, index) => click(role('button', `Next page ${index + 1}`)));
const longPlan = () => parsedPlan(planOf([OPEN_ACCOUNT_PAGE, ...EIGHT_CLICKS]));

test('a plan with more steps than the trusted project\'s limit ends Denied as over-limit', { criterion: 'AC-SPEC-03-03' }, async () => {
  const decision = await decideAgainstTrusted(longPlan(), policyProjectInput({ limits: { stepTimeoutMilliseconds: 2000, maximumSteps: 3 } }));
  assert.deepEqual(decision, { kind: 'deny', rule: 'over-limit', stepIndex: null });
});

test('the same plan is allowed within the trusted project\'s limit', { criterion: 'AC-SPEC-03-03' }, async () => {
  const decision = await decideAgainstTrusted(longPlan(), policyProjectInput({ limits: { stepTimeoutMilliseconds: 2000, maximumSteps: 20 } }));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

