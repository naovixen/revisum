// What the own CDP driver does with the clock and clipboard steps, and what an advance must not do.
//   - It performs every step of them.
//   - During an advance the driver dispatches no input event (the fixture page counts every
//     input event, whoever sent it) and asks the runtime guard nothing: the engine's calls on the
//     session are recorded, and no action or guard call falls inside an advance.
// The counter-example runs a plan without those steps, and with clicks around the advance, so the
// counters and the recording can be seen to move.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, navigate, role, testId, textEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { INVITE_CODE, advanceClock, clockHarness, expectClipboard, recordingSessionCalls, rememberClipboard, type ClockHarness } from './support/ClockPlan.ts';
import { guardHostClipboard } from './support/HostClipboard.ts';
import { ClockAdvanceMode } from '@revisum/contracts';

const hostClipboard = await guardHostClipboard();
const copying = { skip: hostClipboard.skipReason ?? false };

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => {
  await harness.close();
  await hostClipboard.restore();
});

// Each step passes on the clipboard page after its copy.
const CLOCK_AND_CLIPBOARD_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'an advanceClock in the default mode', step: advanceClock(1, 'hours') },
  { name: 'an advanceClock in runTimers mode', step: advanceClock(1, 'hours', 'runTimers') },
  { name: 'an advanceClock in skipAhead mode', step: advanceClock(1, 'hours', 'skipAhead') },
  { name: 'an expectClipboard with textEquals', step: expectClipboard('textEquals', INVITE_CODE, 'support.clipboard-equals') },
  { name: 'an expectClipboard with textContains', step: expectClipboard('textContains', 'HX-4471', 'support.clipboard-contains') },
  { name: 'an expectClipboard with textExcludes', step: expectClipboard('textExcludes', 'password', 'support.clipboard-excludes') },
  { name: 'a remember from the clipboard', step: rememberClipboard('inviteCode') },
];

const continueStep = click(role('button', 'Continue'));
const continued = (): JsonRecord => textEquals(testId('continue-state'), 'Continued', 'support.continued');
const copyInviteCode = click(role('button', 'Copy invite code'));
// Open the page, copy what the clipboard steps check, use the step, then send input and check the page.
const performedSteps = (step: JsonRecord): unknown[] => [navigate('/clipboard.html'), copyInviteCode, step, continueStep, continued()];

describe(`the own CDP driver: ${BrowserTarget.Chrome}`, () => {
  test('counter-example: a run without any of those steps passes and sends its input', async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [navigate('/clipboard.html'), continueStep, continued()], { read: ['input-events'] });
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.notEqual(ran.atClose?.shown['input-events'], '0', 'the click reached the page');
  });

  for (const { name, step } of CLOCK_AND_CLIPBOARD_STEPS) {
    test(`a run with ${name} performs it and passes`, { ...copying }, async () => {
      const ran = await harness.runSteps(BrowserTarget.Chrome, performedSteps(step));
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
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
    test(`a ${mode} advance whose timers change the page dispatches no input event and asks the runtime guard nothing`, async () => {
      const cdp = harness.drivers.get('cdp');
      assert.ok(cdp !== undefined);
      const recorder = recordingSessionCalls(cdp);
      const ran = await harness.runSteps(BrowserTarget.Chrome, [
        navigate('/timer-order.html'),
        advanceClock(120, 'milliseconds', mode),
        textEquals(testId('timer-counts'), mode === ClockAdvanceMode.RunTimers
          ? 'interval-30:4, timeout-50:1, promise-after-timeout-50:1, nested-timeout-20:1, timeout-100-first:1, timeout-100-second:1'
          : 'interval-30:1, timeout-50:1, promise-after-timeout-50:1, nested-timeout-20:0, timeout-100-first:1, timeout-100-second:1', 'guard.timers-ran'),
        textEquals(testId('input-events'), '0', 'guard.no-input'),
      ], { drivers: new Map([...harness.drivers, ['cdp', recorder.driver]]) });
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
      assert.deepEqual(recorder.calls, ['advance-start', 'advance-end'], 'the advance went through the clock port, with no action or guard call anywhere');
    });
  }

  test('with clicks before and after it, the advance holds no action and no guard call, and the input counter moves only for the clicks', async () => {
    const cdp = harness.drivers.get('cdp');
    assert.ok(cdp !== undefined);
    const recorder = recordingSessionCalls(cdp);
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
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

  test('mutant: a recording with an action inside an advance is caught', () => {
    assert.deepEqual(callsDuringAdvances(['act', 'guard', 'advance-start', 'act', 'guard', 'advance-end']), ['act', 'guard']);
  });
});
