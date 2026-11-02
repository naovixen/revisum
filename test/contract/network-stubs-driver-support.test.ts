// Which driver performs declared stubs, request checks and web storage. The own CDP driver
// declares the three features (networkStubs, requestChecks, storage) and performs every step of
// them, so the same plans pass there. With a feature taken off its list, a run with any of its
// steps fails that step with unsupported-step, never a partial result, and skips the rest, with
// nothing of the step reaching the page. A driver that declares only some of the features is
// refused only the steps of the ones it lacks, so the run decides by feature, not by driver.
// The refusal is paired with the same plan without any of those steps, which the driver does run.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { outcomes } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { cdpWithout, listedFeatures } from '#test-support/browser/DriversWithout.ts';
import { click, navigate, role, testId, textEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { expectRequests, expectResponse, expectStorage, networkHarness, rememberResponse, removeStorage, resetRequests, setStorage, startStub, timesRequested, type NetworkHarness } from './network-stubs-support.ts';

let harness: NetworkHarness;
before(async () => { harness = await networkHarness(); });
after(async () => { await harness.close(); });

const NETWORK_FEATURES = ['networkStubs', 'requestChecks', 'storage'] as const;
type NetworkFeature = (typeof NETWORK_FEATURES)[number];

type FeatureStep = { readonly name: string; readonly feature: NetworkFeature; readonly step: JsonRecord };

// Every step of this spec's features, each on the requests page, where the schedule loads once.
const FEATURE_STEPS: readonly FeatureStep[] = [
  { name: 'a stub start', feature: 'networkStubs', step: startStub('answerSequence') },
  { name: 'a resetRequests', feature: 'requestChecks', step: resetRequests('scheduleLoads') },
  { name: 'an expectRequests', feature: 'requestChecks', step: expectRequests('scheduleLoads', { equals: 1 }, 'support.schedule-count') },
  { name: 'an expectResponse', feature: 'requestChecks', step: expectResponse('scheduleLoads', { kind: 'statusEquals', value: 200 }, 'support.schedule-status') },
  { name: 'a remember from a response', feature: 'requestChecks', step: rememberResponse('scheduleDay', 'scheduleLoads', 'day', 'text') },
  { name: 'a setStorage', feature: 'storage', step: setStorage('menuDocked', { docked: true }) },
  { name: 'a removeStorage', feature: 'storage', step: removeStorage('menuDocked') },
  { name: 'an expectStorage', feature: 'storage', step: expectStorage('menuDocked', { kind: 'absent' }, 'support.menu-absent') },
];

const continued = (): JsonRecord => textEquals(testId('continue-state'), 'Continued', 'support.continued');
// Open the page, wait for its schedule, use the feature, then send input and check the page.
const stepsWith = (step: JsonRecord): unknown[] => [
  navigate('/requests.html'), textEquals(testId('schedule-state'), 'Schedule loaded', 'support.schedule-loaded'),
  step, click(role('button', 'Continue')), continued(),
];

test('the own CDP driver declares networkStubs, requestChecks and storage', () => {
  const cdp = listedFeatures(harness.drivers.get('cdp'));
  for (const feature of NETWORK_FEATURES) {
    assert.ok(cdp.includes(feature), `the CDP driver declares ${feature}: ${JSON.stringify(cdp)}`);
  }
});

describe(`the own CDP driver with the step's feature taken off its list: ${BrowserTarget.Chrome}`, () => {
  for (const { name, feature, step } of FEATURE_STEPS) {
    test(`a run with ${name} fails that step with unsupported-step, sends nothing and skips the rest`, async () => {
      const ran = await harness.runSteps(BrowserTarget.Chrome, stepsWith(step), { drivers: cdpWithout(harness, feature), read: ['input-events', 'continue-state'] });
      assert.equal(ran.result.state, 'Failed');
      assert.deepEqual(outcomes(ran.result), [
        [0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined],
      ]);
      assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
      assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
    });
  }

  // The run never goes on without the stub: the request the stub would have answered is never sent.
  test('a refused stub start ends the run before the request it would have answered is sent', async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
      navigate('/requests.html'), startStub('answerSequence'), click(role('button', 'Ask for the next answer')),
      textEquals(testId('answers'), '1', 'support.stubbed-answer'),
    ], { drivers: cdpWithout(harness, 'networkStubs') });
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.equal(timesRequested(ran.requestedPaths, '/api/sequence'), 0, 'the skipped click sent nothing');
  });

  test('counter-example: the same run without any of those steps passes and sends its input', async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
      navigate('/requests.html'), textEquals(testId('schedule-state'), 'Schedule loaded', 'support.schedule-loaded'),
      click(role('button', 'Continue')), continued(),
    ]);
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  });
});

describe(`the own CDP driver: ${BrowserTarget.Chrome}`, () => {
  for (const { name, step } of FEATURE_STEPS) {
    test(`a run with ${name} performs it and passes`, async () => {
      const ran = await harness.runSteps(BrowserTarget.Chrome, stepsWith(step));
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    });
  }

  for (const lacking of NETWORK_FEATURES) {
    test(`with ${lacking} taken off its list, the driver is refused that feature's steps and still runs the others`, { timeout: 300_000 }, async () => {
      const drivers = cdpWithout(harness, lacking);
      for (const { name, feature, step } of FEATURE_STEPS) {
        const ran = await harness.runSteps(BrowserTarget.Chrome, stepsWith(step), { drivers });
        if (feature === lacking) {
          assert.deepEqual(outcomes(ran.result).slice(2), [[2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined]], `${name}: ${JSON.stringify(ran.result.steps)}`);
        } else {
          assert.equal(ran.result.state, 'Passed', `${name}: ${JSON.stringify(ran.result.steps)}`);
        }
      }
    });
  }
});
