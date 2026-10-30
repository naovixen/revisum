// Which driver performs declared stubs, request checks and web storage. The own CDP driver
// declares the three features (networkStubs, requestChecks, storage) and performs every step of
// them, so the same plans pass there. The Playwright fallback declares none: a run with any of
// them fails that step with unsupported-step, never a partial result, and skips the rest, with
// nothing of the step reaching the page. A driver that declares only some of the features is
// refused only the steps of the ones it lacks, so the run decides by feature, not by driver.
// Each refusal is paired with the same plan without the feature, which the fallback does run.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { BrowserDriver } from '@revisum/engine';
import {
  CDP_TARGET, PLAYWRIGHT_TARGET, click, expectRequests, expectResponse, expectStorage, navigate, networkHarness, outcomes, rememberResponse,
  removeStorage, resetRequests, role, setStorage, startStub, testId, textEquals, timesRequested, type JsonRecord, type NetworkHarness,
} from './network-stubs-support.ts';

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

// The features a driver lists, as plain names.
const listedFeatures = (driver: BrowserDriver | undefined): readonly string[] => {
  assert.ok(driver !== undefined, 'the harness has the driver');
  return (driver.info.performs ?? []).map((feature) => String(feature));
};

// The own CDP driver with one feature taken off its list, and nothing else changed.
const cdpWithout = (feature: NetworkFeature): ReadonlyMap<string, BrowserDriver> => {
  const inner = harness.drivers.get('cdp');
  assert.ok(inner !== undefined);
  const performs = (inner.info.performs ?? []).filter((listed) => String(listed) !== feature);
  const lacking = new Proxy(inner, {
    get: (target, key) => (key === 'info' ? { ...target.info, performs } : Reflect.get(target, key, target)),
  });
  return new Map([...harness.drivers, ['cdp', lacking]]);
};

test('the own CDP driver declares networkStubs, requestChecks and storage; the Playwright fallback declares none of them', { criterion: 'AC-SPEC-33-15' }, () => {
  const cdp = listedFeatures(harness.drivers.get('cdp'));
  const playwright = listedFeatures(harness.drivers.get('playwright'));
  for (const feature of NETWORK_FEATURES) {
    assert.ok(cdp.includes(feature), `the CDP driver declares ${feature}: ${JSON.stringify(cdp)}`);
    assert.ok(!playwright.includes(feature), `the Playwright fallback does not declare ${feature}`);
  }
});

describe(`the Playwright fallback: ${PLAYWRIGHT_TARGET}`, () => {
  for (const { name, step } of FEATURE_STEPS) {
    test(`a run with ${name} fails that step with unsupported-step, sends nothing and skips the rest`, { criterion: 'AC-SPEC-33-15' }, async () => {
      const ran = await harness.runSteps(PLAYWRIGHT_TARGET, stepsWith(step), { read: ['input-events', 'continue-state'] });
      assert.equal(ran.result.state, 'Failed');
      assert.deepEqual(outcomes(ran.result), [
        [0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined],
      ]);
      assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
      assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
    });
  }

  // The run never goes on without the stub: the request the stub would have answered is never sent.
  test('a refused stub start ends the run before the request it would have answered is sent', { criterion: 'AC-SPEC-33-15' }, async () => {
    const ran = await harness.runSteps(PLAYWRIGHT_TARGET, [
      navigate('/requests.html'), startStub('answerSequence'), click(role('button', 'Ask for the next answer')),
      textEquals(testId('answers'), '1', 'support.stubbed-answer'),
    ]);
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.equal(timesRequested(ran.requestedPaths, '/api/sequence'), 0, 'the skipped click sent nothing');
  });

  test('counter-example: the same run without any of those steps passes and sends its input', { criterion: 'AC-SPEC-33-15' }, async () => {
    const ran = await harness.runSteps(PLAYWRIGHT_TARGET, [
      navigate('/requests.html'), textEquals(testId('schedule-state'), 'Schedule loaded', 'support.schedule-loaded'),
      click(role('button', 'Continue')), continued(),
    ]);
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  });
});

describe(`the own CDP driver: ${CDP_TARGET}`, () => {
  for (const { name, step } of FEATURE_STEPS) {
    test(`a run with ${name} performs it and passes`, { criterion: 'AC-SPEC-33-15' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, stepsWith(step));
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    });
  }

  for (const lacking of NETWORK_FEATURES) {
    test(`with ${lacking} taken off its list, the driver is refused that feature's steps and still runs the others`, { criterion: 'AC-SPEC-33-15', timeout: 300_000 }, async () => {
      const drivers = cdpWithout(lacking);
      for (const { name, feature, step } of FEATURE_STEPS) {
        const ran = await harness.runSteps(CDP_TARGET, stepsWith(step), { drivers });
        if (feature === lacking) {
          assert.deepEqual(outcomes(ran.result).slice(2), [[2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined]], `${name}: ${JSON.stringify(ran.result.steps)}`);
        } else {
          assert.equal(ran.result.state, 'Passed', `${name}: ${JSON.stringify(ran.result.steps)}`);
        }
      }
    });
  }
});
