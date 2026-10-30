// Which driver performs the driver parts of plan language 1.2. The own CDP driver performs a
// remember step, a positioned locator and a key chord, so the engine no longer reports them as
// unsupported-step. The Playwright fallback refuses each of them with unsupported-step, sending
// nothing: the run fails that step and skips the rest, and the fixture page
// (fixtures/plan-values-app/remember.html) counts no input event. Each refusal is paired with the
// same plan without the feature, which the fallback does run.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, PLAYWRIGHT_TARGET, click, label, navigate, outcomes, planValuesHarness, press, remember, role, testId, textEquals,
  type JsonRecord, type PlanValuesHarness,
} from './plan-values-support.ts';

let harness: PlanValuesHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

type Feature = { readonly name: string; readonly withFeature: JsonRecord; readonly without: JsonRecord };

const FEATURES: readonly Feature[] = [
  {
    name: 'a remember step',
    withFeature: remember('orderNumber', testId('order-number')),
    without: textEquals(testId('order-number'), 'ORD-58213', 'refusals.order-number-shown'),
  },
  {
    name: 'a positioned locator',
    withFeature: click(role('button', 'Save', { position: 1 })),
    without: click(role('button', 'Save')),
  },
  {
    name: 'a key chord',
    withFeature: press(label('Search'), 'k', ['Shift']),
    without: press(label('Search'), 'k'),
  },
];

// Open the page, use the feature, then send input and check the page.
const stepsWith = (step: JsonRecord) => [
  navigate('/remember.html'), step, click(role('button', 'Save')), textEquals(testId('order-number'), 'ORD-58213', 'refusals.page-shown'),
];

describe(`the Playwright fallback: ${PLAYWRIGHT_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} fails that step with unsupported-step, sends nothing and skips the rest`, { criterion: 'AC-SPEC-30-19' }, async () => {
      const { result, atClose } = await harness.runSteps(PLAYWRIGHT_TARGET, stepsWith(feature.withFeature));
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
      assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
    });

    test(`counter-example: the same run without ${feature.name} passes and sends its input`, { criterion: 'AC-SPEC-30-19' }, async () => {
      const { result, atClose } = await harness.runSteps(PLAYWRIGHT_TARGET, stepsWith(feature.without));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }
});

describe(`the own CDP driver: ${CDP_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} performs it and passes`, { criterion: 'AC-SPEC-30-19' }, async () => {
      const { result, atClose } = await harness.runSteps(CDP_TARGET, stepsWith(feature.withFeature));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }
});
