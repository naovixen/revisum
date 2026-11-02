// Which driver performs the driver parts of the plan language. The own CDP driver performs a
// remember step, a positioned locator and a key chord. With the feature taken off its list, and
// nothing else changed, the run refuses each of them with unsupported-step, sending nothing: the
// run fails that step and skips the rest, and the fixture page (fixtures/plan-values-app/remember.html)
// counts no input event. Each refusal is paired with the same plan without the feature, which the
// reduced driver does run.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, cdpWithout, click, label, navigate, outcomes, planValuesHarness, press, remember, role, testId, textEquals,
  type JsonRecord, type PlanValuesFeature, type PlanValuesHarness,
} from './plan-values-support.ts';

let harness: PlanValuesHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

type Feature = { readonly name: string; readonly listedAs: PlanValuesFeature; readonly withFeature: JsonRecord; readonly without: JsonRecord };

const FEATURES: readonly Feature[] = [
  {
    name: 'a remember step', listedAs: 'rememberedValues',
    withFeature: remember('orderNumber', testId('order-number')),
    without: textEquals(testId('order-number'), 'ORD-58213', 'refusals.order-number-shown'),
  },
  {
    name: 'a positioned locator', listedAs: 'positions',
    withFeature: click(role('button', 'Save', { position: 1 })),
    without: click(role('button', 'Save')),
  },
  {
    name: 'a key chord', listedAs: 'keyChords',
    withFeature: press(label('Search'), 'k', ['Shift']),
    without: press(label('Search'), 'k'),
  },
];

// Open the page, use the feature, then send input and check the page.
const stepsWith = (step: JsonRecord) => [
  navigate('/remember.html'), step, click(role('button', 'Save')), textEquals(testId('order-number'), 'ORD-58213', 'refusals.page-shown'),
];

describe(`the own CDP driver with one feature taken off its list: ${CDP_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} fails that step with unsupported-step, sends nothing and skips the rest`, async () => {
      const drivers = cdpWithout(harness, feature.listedAs);
      const { result, atClose } = await harness.runSteps(CDP_TARGET, stepsWith(feature.withFeature), { drivers });
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
      assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
    });

    test(`counter-example: the same run without ${feature.name} passes and sends its input`, async () => {
      const drivers = cdpWithout(harness, feature.listedAs);
      const { result, atClose } = await harness.runSteps(CDP_TARGET, stepsWith(feature.without), { drivers });
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }
});

describe(`the own CDP driver: ${CDP_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} performs it and passes`, async () => {
      const { result, atClose } = await harness.runSteps(CDP_TARGET, stepsWith(feature.withFeature));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }
});
