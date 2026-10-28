// Until the CDP driver performs them, runs report the 1.2 steps that need a driver's help as failed
// with unsupported-step: a positioned locator, a declared test-id attribute other than the
// default, a key chord, a multi-line fill and a remember step. The step never acts in part: no
// action reaches the driver and every later step is skipped. Each counter-example runs the same
// plan without the feature and does reach the driver.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_ORDERS, label, planOf, projectFileWith, runPlan, type JsonRecord } from './run-value-examples.ts';

const PROJECT_FILE = projectFileWith({ testIdAttributes: ['data-testid', 'data-qa'] });
const AFTER: JsonRecord = { type: 'click', locator: { by: 'role', role: 'button', name: 'Continue' } };

type Feature = { readonly name: string; readonly withFeature: JsonRecord; readonly without: JsonRecord };

const FEATURES: readonly Feature[] = [
  {
    name: 'a positioned locator',
    withFeature: { type: 'click', locator: { by: 'role', role: 'button', name: 'Open', position: 2 } },
    without: { type: 'click', locator: { by: 'role', role: 'button', name: 'Open' } },
  },
  {
    name: 'a declared test-id attribute',
    withFeature: { type: 'click', locator: { by: 'testId', testId: 'save', attribute: 'data-qa' } },
    without: { type: 'click', locator: { by: 'testId', testId: 'save' } },
  },
  {
    name: 'a key chord',
    withFeature: { type: 'press', locator: label('Search'), key: 'Enter', modifiers: ['Shift'] },
    without: { type: 'press', locator: label('Search'), key: 'Enter' },
  },
  {
    name: 'a multi-line fill',
    withFeature: { type: 'fill', locator: label('Message'), value: { lines: ['Hello', 'Second line'] } },
    without: { type: 'fill', locator: label('Message'), value: 'Hello' },
  },
];

for (const feature of FEATURES) {
  test(`a run with ${feature.name} fails that step with unsupported-step, sends no action and skips the rest`, { criterion: 'AC-SPEC-30-19' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, feature.withFeature, AFTER]), { projectFile: PROJECT_FILE });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
      [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined],
    ]);
    assert.deepEqual(recording.actions, [], 'no action reached the driver');
  });

  test(`counter-example: the same run without ${feature.name} sends its actions and passes`, { criterion: 'AC-SPEC-30-19' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, feature.without, AFTER]), { projectFile: PROJECT_FILE });
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.deepEqual(recording.actions.map((action) => action.type), [String(feature.without['type']), 'click']);
  });
}

test('a run with a remember step fails it with unsupported-step and skips every later step', { criterion: 'AC-SPEC-30-19' }, async () => {
  const remember = { type: 'remember', name: 'orderNumber', from: { element: label('Order number'), read: 'text' } };
  const use = { type: 'fill', locator: label('Search'), value: { valueName: 'orderNumber' } };
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, remember, use]), { projectFile: PROJECT_FILE });
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
    [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined],
  ]);
  assert.deepEqual(recording.actions, [], 'no action reached the driver');
});
