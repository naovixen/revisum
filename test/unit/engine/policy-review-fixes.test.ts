// Gaps an independent review of the policy gate found, each with a counter-example that passes:
//   - a URL on the origin the gate reads relative paths against must never reach it as absolute;
//   - with no targets, the engine's own irreversible patterns did not apply;
//   - a plan the gate cleared under one project's allowances could run under another project;
//   - names written in camelCase, with a soft hyphen, or in full-width letters escaped the patterns;
//   - an audit sink that failed to record a denial let the denial pass silently.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failure, policyGate, run, runUntrusted, type EventSink, type RunResult } from '@revisum/engine';
import { memoryEventSink } from './approval-repositories.ts';
import { finalState, guardedDriver, onlyRun, parserFor, portsWithoutAudit, runBase } from './guarded-driver.ts';
import {
  CLOSING_CHECK, ENGLISH, OPEN_ACCOUNT_PAGE, ORIGIN, PRODUCTION_ORIGIN,
  click, decideOn, element, localeOf, navigate, parsedPlan, planOf, policyProjectInput, role, stepAt, targetsOf, testGate, testId,
  trustedProject, withPolicy,
} from './policy-examples.ts';

// ---- Absolute URLs on the gate's own placeholder origin ------------------------------------------

// The origin the gate and the plan parser read relative paths against. The gate treats any URL on
// it as relative, so it relies on the parser never letting a plan name it as an absolute URL. A
// step holding such a URL can only be made by a cast, so the gate is tested here through the parser.
const PLACEHOLDER_ORIGIN = 'https://relative.invalid';
// A project whose plan parser would accept the placeholder origin like any declared origin.
const WITH_PLACEHOLDER = policyProjectInput({ origins: [ORIGIN, PRODUCTION_ORIGIN, PLACEHOLDER_ORIGIN] });

test('a plan that navigates to an absolute URL on the placeholder origin never reaches the gate: it is rejected and opens no browser', { criterion: 'AC-SPEC-03-02' }, async () => {
  const steps = [OPEN_ACCOUNT_PAGE, navigate(`${PLACEHOLDER_ORIGIN}/admin`)];
  for (const projectInput of [policyProjectInput(), WITH_PLACEHOLDER]) {
    const driven = guardedDriver([...steps, CLOSING_CHECK]);
    const outcome = await runUntrusted(planOf(steps), parserFor(projectInput), runBase(projectInput), { ...portsWithoutAudit(driven.driver), audit: memoryEventSink() });
    assert.equal(finalState(outcome), 'Rejected', JSON.stringify(outcome));
    assert.equal(driven.opens(), 0);
  }
});

test('a plan that navigates to a relative path runs, on the base URL', { criterion: 'AC-SPEC-03-02' }, async () => {
  const steps = [OPEN_ACCOUNT_PAGE, navigate('/admin')];
  const driven = guardedDriver([...steps, CLOSING_CHECK]);
  const outcome = await runUntrusted(planOf(steps), parserFor(), runBase(), { ...portsWithoutAudit(driven.driver), audit: memoryEventSink() });
  assert.equal(finalState(outcome), 'Passed', JSON.stringify(onlyRun(outcome)?.steps ?? outcome));
  assert.equal(decideOn(await testGate(), parsedPlan(planOf(steps))).kind, 'allow');
});

// ---- The engine's patterns apply with no targets -------------------------------------------------

const DELETE_STEPS = [OPEN_ACCOUNT_PAGE, click(role('button', 'Delete account'))];
const SAVE_STEPS = [OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))];

test('with no targets, a click on Delete account is still denied as irreversible-action', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { gate } = await testGate();
  assert.deepEqual(gate.decide(parsedPlan(planOf(DELETE_STEPS)), []), { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
});

test('with no targets, a click on Save changes is not denied as irreversible-action', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { gate } = await testGate();
  const decision = gate.decide(parsedPlan(planOf(SAVE_STEPS)), []);
  assert.ok(decision.kind === 'allow' || decision.rule !== 'irreversible-action', JSON.stringify(decision));
});

// ---- Authorisation belongs to the project that gave it -------------------------------------------

// Project A allows the irreversible name "Delete account"; project B, the default, does not.
const ALLOWS_DELETE = withPolicy({ allowedIrreversibleNames: ['Delete account'] });

async function runClearedUnderA(runProjectInput: Record<string, unknown>) {
  const projectA = await trustedProject(ALLOWS_DELETE);
  const plan = parsedPlan(planOf(DELETE_STEPS), ALLOWS_DELETE);
  const decision = policyGate({ project: projectA, events: memoryEventSink() }).decide(plan, targetsOf(projectA, plan));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  if (decision.kind !== 'allow') throw new Error('unreachable');
  const targetId = plan.targets[0];
  if (targetId === undefined) throw new Error('the test plan has no target');
  const driven = guardedDriver([...DELETE_STEPS, CLOSING_CHECK]);
  let result: RunResult | undefined;
  let thrown: unknown;
  try {
    result = await run({ ...runBase(runProjectInput), plan: decision.plan, targetId },
      { ...portsWithoutAudit(driven.driver), audit: memoryEventSink() });
  } catch (error) {
    thrown = error;
  }
  return { result, thrown, driven };
}

test('a plan cleared under one project\'s allowed names is refused before any browser opens when run under a project that does not allow them', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { result, thrown, driven } = await runClearedUnderA(policyProjectInput());
  assert.equal(driven.opens(), 0, `the run opened a browser and ended ${result?.state ?? 'nowhere'}`);
  assert.ok(thrown !== undefined || (result !== undefined && result.state !== 'Passed'), JSON.stringify(result));
});

test('the same plan runs to the end under the project that cleared it', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { result, thrown, driven } = await runClearedUnderA(ALLOWS_DELETE);
  assert.equal(thrown, undefined);
  assert.equal(result?.state, 'Passed', JSON.stringify(result?.steps));
  assert.equal(driven.inputEvents[1], 1);
});

// ---- Names written to slip past the patterns -----------------------------------------------------

// Each is the English pattern "delete" once compatibility forms are folded (NFKC), invisible
// format characters removed and camelCase words split.
const DISGUISED_NAMES: readonly (readonly [string, string])[] = [
  ['camelCase', 'DeleteAccount'],
  ['lower camelCase', 'deleteAccount'],
  ['a soft hyphen inside the word', 'Del­ete account'],
  ['full-width letters', 'Ｄｅｌｅｔｅ account'],
];

// Names that only look like the pattern, and must still pass.
const LOOK_ALIKE_NAMES: readonly string[] = ['DeletedItems', 'Deleted items', 'Delegate account', 'UndeleteItem'];

for (const [how, name] of DISGUISED_NAMES) {
  test(`the runtime guard denies a click on a control named "Delete account" written in ${how}`, { criterion: 'AC-SPEC-03-11' }, async () => {
    const { gate, project } = await testGate();
    const step = stepAt(parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))])), 1);
    const verdict = gate.guardAction(step, 1, element({ role: 'button', name }), null, localeOf(project, ENGLISH));
    assert.deepEqual(verdict, { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
  });

  test(`the static check denies a click on a button named "Delete account" written in ${how}`, { criterion: 'AC-SPEC-03-11' }, async () => {
    const plan = parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(role('button', name))]));
    assert.deepEqual(decideOn(await testGate(), plan), { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
  });
}

for (const name of LOOK_ALIKE_NAMES) {
  test(`a control named "${name}" is still allowed: only whole words match`, { criterion: 'AC-SPEC-03-11' }, async () => {
    const { gate, project } = await testGate();
    const step = stepAt(parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))])), 1);
    assert.deepEqual(gate.guardAction(step, 1, element({ role: 'button', name }), null, localeOf(project, ENGLISH)), { kind: 'allow' });
    assert.equal(decideOn(await testGate(), parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(role('button', name))]))).kind, 'allow');
  });
}

// ---- A denial the audit sink failed to record ----------------------------------------------------

// A sink whose every append fails, as a full disc or a rewritten log would make it.
const failingSink = (): EventSink & { attempts: number } => {
  const sink = { attempts: 0, append: () => { sink.attempts++; return failure({ code: 'write-failed' as const }); } };
  return sink;
};

const DELETE_PLAN = planOf(DELETE_STEPS);
// The red-team's runtime click: a test id that turns out to be the Delete account button.
const RUNTIME_DELETE_STEPS = [OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))];
const RUNTIME_DELETE_PAGE = { 1: { element: { role: 'button', name: 'Delete account' } } };

async function settle<Value>(work: Promise<Value>): Promise<{ readonly value?: Value; readonly thrown?: unknown }> {
  try {
    return { value: await work };
  } catch (error) {
    return { thrown: error };
  }
}

test('when the audit sink fails to record a static denial, the outcome says so rather than a plain Denied', { criterion: 'AC-SPEC-03-05' }, async () => {
  const driven = guardedDriver([...DELETE_STEPS, CLOSING_CHECK]);
  const sink = failingSink();
  const settled = await settle(runUntrusted(DELETE_PLAN, parserFor(), runBase(), { ...portsWithoutAudit(driven.driver), audit: sink }));
  assert.ok(sink.attempts > 0, 'the denial was never offered to the sink');
  assert.equal(driven.opens(), 0, 'a denied plan opened a browser');
  if (settled.thrown !== undefined) return;
  assert.notDeepEqual(settled.value, { state: 'Denied', rule: 'irreversible-action', stepIndex: 1 },
    'the denial went unrecorded, yet the outcome looks exactly like a recorded one');
});

test('when the audit sink records a static denial, the outcome is a plain Denied', { criterion: 'AC-SPEC-03-05' }, async () => {
  const driven = guardedDriver([...DELETE_STEPS, CLOSING_CHECK]);
  const sink = memoryEventSink();
  const outcome = await runUntrusted(DELETE_PLAN, parserFor(), runBase(), { ...portsWithoutAudit(driven.driver), audit: sink });
  assert.deepEqual(outcome, { state: 'Denied', rule: 'irreversible-action', stepIndex: 1 });
  assert.equal(sink.recorded.length, 1);
});

async function runtimeDenial(audit: EventSink) {
  const driven = guardedDriver([...RUNTIME_DELETE_STEPS, CLOSING_CHECK], RUNTIME_DELETE_PAGE);
  const settled = await settle(runUntrusted(planOf(RUNTIME_DELETE_STEPS), parserFor(), runBase(), { ...portsWithoutAudit(driven.driver), audit }));
  return { settled, driven };
}

test('when the audit sink fails to record a runtime denial, the run result differs from one whose denial was recorded', { criterion: 'AC-SPEC-03-05' }, async () => {
  const recorded = await runtimeDenial(memoryEventSink());
  const sink = failingSink();
  const unrecorded = await runtimeDenial(sink);
  assert.ok(sink.attempts > 0, 'the denial was never offered to the sink');
  assert.equal(unrecorded.driven.inputEvents[1], 0, 'the denied click sent an input event');
  if (unrecorded.settled.thrown !== undefined) return;
  const failed = onlyRun(unrecorded.settled.value ?? []);
  assert.ok(failed !== undefined && failed.state !== 'Passed', JSON.stringify(failed?.steps));
  assert.notEqual(failed.resultHash, onlyRun(recorded.settled.value ?? [])?.resultHash,
    'the denial went unrecorded, yet the result is identical to a recorded one');
});

test('two runs whose runtime denial was recorded give the same result', { criterion: 'AC-SPEC-03-05' }, async () => {
  const first = await runtimeDenial(memoryEventSink());
  const second = await runtimeDenial(memoryEventSink());
  assert.equal(finalState(first.settled.value ?? []), 'Denied');
  assert.equal(onlyRun(first.settled.value ?? [])?.resultHash, onlyRun(second.settled.value ?? [])?.resultHash);
});
