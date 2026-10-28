// Until the CDP driver carries them out, runs report every step of declared stubs, request checks
// and web storage as failed with unsupported-step: starting or stopping a stub, resetting or
// checking requests, checking or remembering a response, and writing, removing or checking storage.
// The step never gives a partial result: no probe, action or navigation of it reaches the driver,
// and every later step is skipped. The counter-example runs the same plan without the step and
// does reach the driver.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_ORDERS, runPlan } from './run-value-examples.ts';
import {
  ORIGIN, expectRequests, expectResponse, expectStorage, planOf, rememberResponse, removeStorage, resetRequests, setStorage, startStub,
  stopStub, stubProjectFile, type JsonRecord,
} from './stub-and-storage-examples.ts';

const PROJECT_FILE = stubProjectFile();
const AFTER: JsonRecord = { type: 'click', locator: { by: 'role', role: 'button', name: 'Continue' } };

// Each step's declaration is allowed in proposals where that matters, since runPlan runs a proposal.
const FEATURES: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'a stub start', step: startStub('loginNeedsCode', { reason: 'Enter the code from your app' }) },
  { name: 'a stub start with no arguments', step: startStub('cartEmpty') },
  { name: 'a resetRequests', step: resetRequests('likes') },
  { name: 'an expectRequests', step: expectRequests('scheduleLoads', { equals: 0 }) },
  { name: 'an expectResponse', step: expectResponse('likes', { kind: 'statusEquals', value: 200 }) },
  { name: 'a remember from a response', step: rememberResponse('likeCount', 'likes', 'likeList', 'arrayLength') },
  { name: 'a setStorage', step: setStorage('pinnedMenu', { docked: true }) },
  { name: 'a removeStorage', step: removeStorage('pinnedMenu') },
  { name: 'an expectStorage', step: expectStorage('privateKey', { kind: 'absent' }) },
];

// What the driver was asked, other than opening the session.
const reached = (recording: { readonly navigations: readonly string[]; readonly actions: readonly unknown[]; readonly probes: number }) =>
  ({ navigations: recording.navigations, actions: recording.actions.length, probes: recording.probes });

for (const { name, step } of FEATURES) {
  test(`a run with ${name} fails that step with unsupported-step, sends nothing of it and skips the rest`, { criterion: 'AC-SPEC-33-15' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, step, AFTER]), { projectFile: PROJECT_FILE });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.type, stepResult.outcome, stepResult.code]), [
      [0, 'navigate', 'passed', undefined], [1, String(step['type']), 'failed', 'unsupported-step'],
      [2, 'click', 'skipped', undefined], [3, 'expect', 'skipped', undefined],
    ]);
    assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 }, 'only the first navigation reached the driver');
  });
}

// Counter-example: the same run, on the same project, without the step reaches the driver.
test('counter-example: the same run without any of those steps clicks and checks the page, and passes', { criterion: 'AC-SPEC-33-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, AFTER]), { projectFile: PROJECT_FILE });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`]);
  assert.deepEqual(recording.actions.map((action) => action.type), ['click']);
  assert.ok(recording.probes > 0, 'the closing check read the page');
});

// A stop needs an earlier start, which fails first; the stop is skipped, never performed alone.
test('a stub stop after a start that failed with unsupported-step is skipped', { criterion: 'AC-SPEC-33-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, startStub('cartEmpty'), stopStub('cartEmpty'), AFTER]), { projectFile: PROJECT_FILE });
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.type, stepResult.outcome, stepResult.code]), [
    [0, 'navigate', 'passed', undefined], [1, 'stub', 'failed', 'unsupported-step'], [2, 'stub', 'skipped', undefined],
    [3, 'click', 'skipped', undefined], [4, 'expect', 'skipped', undefined],
  ]);
  assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 });
});

test('a stub started before the first navigation fails with unsupported-step and the page is never loaded', { criterion: 'AC-SPEC-33-15' }, async () => {
  const { result, recording } = await runPlan(planOf([startStub('cartEmpty'), OPEN_ORDERS]), { projectFile: PROJECT_FILE });
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.outcome, stepResult.code]), [
    [0, 'failed', 'unsupported-step'], [1, 'skipped', undefined], [2, 'skipped', undefined],
  ]);
  assert.deepEqual(recording.navigations, [], 'no page was loaded behind a stub that never started');
});
