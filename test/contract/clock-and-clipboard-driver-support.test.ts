// Which driver advances the clock and reads the clipboard, and what an advance must not do.
//   - The own CDP driver declares clockControl and clipboard and performs every step of them. The
//     Playwright fallback declares neither: a run with any of them fails that step with
//     unsupported-step, sends nothing, waits no real time and skips the rest. A CDP driver with
//     one feature taken off its list is refused only that feature's steps.
//   - During an advance the driver dispatches no input event (the fixture page counts every
//     input event, whoever sent it) and asks the runtime guard nothing: the engine's calls on the
//     session are recorded, and no action or guard call falls inside an advance.
// The counter-examples run the same plans without the feature, and with clicks around the advance,
// so the counters and the recording can be seen to move.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, CLOCK_AND_CLIPBOARD_FEATURES, INVITE_CODE, PLAYWRIGHT_TARGET, advanceClock, cdpWithout, click, clockHarness, expectClipboard,
  listedFeatures, navigate, outcomes, recordingSessionCalls, rememberClipboard, role, stepMilliseconds, testId, textEquals,
  type ClockAndClipboardFeature, type ClockHarness, type JsonRecord,
} from './clock-and-clipboard-support.ts';
import { guardHostClipboard } from './host-clipboard.ts';

const hostClipboard = await guardHostClipboard();
const copying = { skip: hostClipboard.skipReason ?? false };

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => {
  await harness.close();
  await hostClipboard.restore();
});

type FeatureStep = { readonly name: string; readonly feature: ClockAndClipboardFeature; readonly step: JsonRecord };

// Every step of this spec's features. Each would pass on the clipboard page after its copy.
const FEATURE_STEPS: readonly FeatureStep[] = [
  { name: 'an advanceClock in the default mode', feature: 'clockControl', step: advanceClock(1, 'hours') },
  { name: 'an advanceClock in runTimers mode', feature: 'clockControl', step: advanceClock(1, 'hours', 'runTimers') },
  { name: 'an advanceClock in skipAhead mode', feature: 'clockControl', step: advanceClock(1, 'hours', 'skipAhead') },
  { name: 'an expectClipboard with textEquals', feature: 'clipboard', step: expectClipboard('textEquals', INVITE_CODE, 'support.clipboard-equals') },
  { name: 'an expectClipboard with textContains', feature: 'clipboard', step: expectClipboard('textContains', 'HX-4471', 'support.clipboard-contains') },
  { name: 'an expectClipboard with textExcludes', feature: 'clipboard', step: expectClipboard('textExcludes', 'password', 'support.clipboard-excludes') },
  { name: 'a remember from the clipboard', feature: 'clipboard', step: rememberClipboard('inviteCode') },
];

const continueStep = click(role('button', 'Continue'));
const continued = (): JsonRecord => textEquals(testId('continue-state'), 'Continued', 'support.continued');
const copyInviteCode = click(role('button', 'Copy invite code'));
// Open the page, use the feature, then send input and check the page. Nothing before the feature
// sends input, so a refusal leaves the input counter at 0.
const refusedSteps = (step: JsonRecord): unknown[] => [navigate('/clipboard.html'), step, continueStep, continued()];
// The same, with the copy the clipboard steps check first.
const performedSteps = (step: JsonRecord): unknown[] => [navigate('/clipboard.html'), copyInviteCode, step, continueStep, continued()];

test('the own CDP driver declares clockControl and clipboard; the Playwright fallback declares neither', { criterion: 'AC-SPEC-34-12' }, () => {
  const cdp = listedFeatures(harness.drivers.get('cdp'));
  const headlessShell = listedFeatures(harness.drivers.get('cdp-headless-shell'));
  const playwright = listedFeatures(harness.drivers.get('playwright'));
  for (const feature of CLOCK_AND_CLIPBOARD_FEATURES) {
    assert.ok(cdp.includes(feature), `the CDP driver declares ${feature}: ${JSON.stringify(cdp)}`);
    assert.ok(headlessShell.includes(feature), `the CDP driver on the headless shell declares ${feature}`);
    assert.ok(!playwright.includes(feature), `the Playwright fallback does not declare ${feature}`);
  }
});

describe(`the Playwright fallback: ${PLAYWRIGHT_TARGET}`, () => {
  for (const { name, step } of FEATURE_STEPS) {
    test(`a run with ${name} fails that step with unsupported-step, sends nothing, waits no real time and skips the rest`, { criterion: 'AC-SPEC-34-12' }, async () => {
      const ran = await harness.runSteps(PLAYWRIGHT_TARGET, refusedSteps(step), { read: ['input-events', 'continue-state'] });
      assert.equal(ran.result.state, 'Failed');
      assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
      assert.ok(stepMilliseconds(ran.result, 1) < 1000, `the refused step took ${stepMilliseconds(ran.result, 1)} ms of real time`);
      assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
      assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
    });
  }

  test('counter-example: the same run without any of those steps passes and sends its input', { criterion: 'AC-SPEC-34-12' }, async () => {
    const ran = await harness.runSteps(PLAYWRIGHT_TARGET, [navigate('/clipboard.html'), continueStep, continued()], { read: ['input-events'] });
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.notEqual(ran.atClose?.shown['input-events'], '0', 'the click reached the page');
  });
});

describe(`the own CDP driver: ${CDP_TARGET}`, () => {
  for (const { name, step } of FEATURE_STEPS) {
    test(`a run with ${name} performs it and passes`, { criterion: 'AC-SPEC-34-12', ...copying }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, performedSteps(step));
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    });
  }

  for (const lacking of CLOCK_AND_CLIPBOARD_FEATURES) {
    test(`with ${lacking} taken off its list, the driver is refused that feature's steps and still runs the others`, { criterion: 'AC-SPEC-34-12', timeout: 300_000, ...copying }, async () => {
      const drivers = cdpWithout(harness, lacking);
      for (const { name, feature, step } of FEATURE_STEPS) {
        const ran = await harness.runSteps(CDP_TARGET, performedSteps(step), { drivers });
        if (feature === lacking) {
          assert.deepEqual(outcomes(ran.result).slice(2), [[2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined]], `${name}: ${JSON.stringify(ran.result.steps)}`);
          assert.ok(stepMilliseconds(ran.result, 2) < 1000, `${name}: the refused step waited no real time`);
        } else {
          assert.equal(ran.result.state, 'Passed', `${name}: ${JSON.stringify(ran.result.steps)}`);
        }
      }
    });
  }
});

// ---- No input and no guard during an advance --------------------------------------------------

// The engine's calls inside each advance, from 'advance-start' to its 'advance-end'.
function callsDuringAdvances(calls: readonly string[]): readonly string[] {
  const inside: string[] = [];
  let depth = 0;
  for (const call of calls) {
    if (call === 'advance-start') { depth += 1; continue; }
    if (call === 'advance-end') { depth -= 1; continue; }
    if (depth > 0) inside.push(call);
  }
  return inside;
}

describe('during an advance', () => {
  for (const mode of ['runTimers', 'skipAhead'] as const) {
    test(`a ${mode} advance whose timers change the page dispatches no input event and asks the runtime guard nothing`, { criterion: 'AC-SPEC-34-18' }, async () => {
      const cdp = harness.drivers.get('cdp');
      assert.ok(cdp !== undefined);
      const recorder = recordingSessionCalls(cdp);
      const ran = await harness.runSteps(CDP_TARGET, [
        navigate('/timer-order.html'),
        advanceClock(120, 'milliseconds', mode),
        textEquals(testId('timer-counts'), mode === 'runTimers'
          ? 'interval-30:4, timeout-50:1, promise-after-timeout-50:1, nested-timeout-20:1, timeout-100-first:1, timeout-100-second:1'
          : 'interval-30:1, timeout-50:1, promise-after-timeout-50:1, nested-timeout-20:0, timeout-100-first:1, timeout-100-second:1', 'guard.timers-ran'),
        textEquals(testId('input-events'), '0', 'guard.no-input'),
      ], { drivers: new Map([...harness.drivers, ['cdp', recorder.driver]]) });
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
      assert.deepEqual(recorder.calls, ['advance-start', 'advance-end'], 'the advance went through the clock port, with no action or guard call anywhere');
    });
  }

  test('with clicks before and after it, the advance holds no action and no guard call, and the input counter moves only for the clicks', { criterion: 'AC-SPEC-34-18' }, async () => {
    const cdp = harness.drivers.get('cdp');
    assert.ok(cdp !== undefined);
    const recorder = recordingSessionCalls(cdp);
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/timer-order.html'),
      continueStep,
      textEquals(testId('continue-state'), 'Continued', 'guard.first-click'),
      advanceClock(1, 'seconds'),
      continueStep,
    ], { drivers: new Map([...harness.drivers, ['cdp', recorder.driver]]), read: ['input-events'] });
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    // The recording can see actions and guard calls: one of each per click, outside the advance.
    assert.deepEqual(recorder.calls, ['act', 'guard', 'advance-start', 'advance-end', 'act', 'guard']);
    assert.deepEqual(callsDuringAdvances(recorder.calls), []);
    const perClick = Number(ran.atClose?.shown['input-events']) / 2;
    assert.ok(Number.isInteger(perClick) && perClick > 0, `the two clicks sent the same number of input events: ${String(ran.atClose?.shown['input-events'])}`);
  });

  test('mutant: a recording with an action inside an advance is caught', { criterion: 'AC-SPEC-34-18' }, () => {
    assert.deepEqual(callsDuringAdvances(['act', 'guard', 'advance-start', 'act', 'guard', 'advance-end']), ['act', 'guard']);
  });
});
