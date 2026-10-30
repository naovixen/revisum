// Advancing the run's virtual clock in a real browser, on the own CDP driver.
//   - A session that expires after 10 minutes (fixtures/clock-and-clipboard-app/session.html) is
//     still active after 9 minutes 59 seconds and expired one second later. The page's Date.now()
//     and performance.now() move by exactly the advances, and each advance takes under 2 seconds.
//   - A page that records its timer callbacks (timer-order.html) shows the exact order and counts
//     a 120 ms runTimers advance gives, and that a skipAhead advance fires each due timer once.
//   - A zero-delay timer loop and an endless animation-frame loop make a long runTimers advance
//     fail with clock-runaway within the step timeout; the run stops there and sends no input.
// Counter-examples show the checks can fail: the expiry check fails one second early, and a short
// advance on the animation-frame page stays under the project's timer limit and passes.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, CDP_TARGETS, CLOCK_START_MILLISECONDS, MAXIMUM_ADVANCE_REAL_MILLISECONDS, MINUTE, STEP_TIMEOUT_MILLISECONDS, absent, advanceClock,
  clockHarness, click, navigate, outcomes, role, stepMilliseconds, testId, text, textEquals, type ClockHarness, type ClockRun,
} from './clock-and-clipboard-support.ts';

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: ClockRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
const showElapsed = click(role('button', 'Show elapsed time'));
const status = (value: string, criterionId: string) => textEquals(testId('session-status'), value, criterionId);

// ---- A session that expires after 10 minutes ----------------------------------------------------

for (const targetId of CDP_TARGETS) {
  describe(`a 10-minute session timer on ${targetId}`, () => {
    test('9 minutes 59 seconds leave the session active; one more second expires it; both clocks moved by exactly the sum', { criterion: 'AC-SPEC-34-05' }, async () => {
      const ran = await harness.runSteps(targetId, [
        navigate('/session.html'),
        status('Session active', 'session.active-at-load'),
        advanceClock(9, 'minutes'),
        advanceClock(59, 'seconds'),
        status('Session active', 'session.active-one-second-early'),
        absent(text('Session expired'), 'session.expiry-absent'),
        showElapsed,
        textEquals(testId('date-elapsed'), String(599 * 1000), 'session.date-moved-9-59'),
        textEquals(testId('performance-elapsed'), String(599 * 1000), 'session.performance-moved-9-59'),
        advanceClock(1, 'seconds'),
        status('Session expired', 'session.expired'),
        showElapsed,
        textEquals(testId('date-elapsed'), String(10 * MINUTE), 'session.date-moved-10-minutes'),
        textEquals(testId('performance-elapsed'), String(10 * MINUTE), 'session.performance-moved-10-minutes'),
        textEquals(testId('date-now'), String(CLOCK_START_MILLISECONDS + 10 * MINUTE), 'session.date-now'),
      ]);
      assertPassed(ran);
      for (const index of [2, 3, 9]) {
        assert.ok(stepMilliseconds(ran.result, index) < MAXIMUM_ADVANCE_REAL_MILLISECONDS,
          `advance at step ${index} took ${stepMilliseconds(ran.result, index)} ms of real time`);
      }
    });
  });
}

test('without an advance, the page\'s clocks have not moved and the session is still active', { criterion: 'AC-SPEC-34-05' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/session.html'),
    showElapsed,
    textEquals(testId('date-elapsed'), '0', 'session.date-still'),
    textEquals(testId('performance-elapsed'), '0', 'session.performance-still'),
    status('Session active', 'session.still-active'),
  ]);
  assertPassed(ran);
});

test('counter-example: checking for the expiry one second early fails', { criterion: 'AC-SPEC-34-05' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/session.html'), advanceClock(9, 'minutes'), advanceClock(59, 'seconds'), status('Session expired', 'session.too-early'),
  ]);
  assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'failed', 'assertion-failed']]);
});

// ---- The order timers fire in -------------------------------------------------------------------

const timerLog = (value: string, criterionId: string) => textEquals(testId('timer-log'), value, criterionId);
const timerCounts = (value: string, criterionId: string) => textEquals(testId('timer-counts'), value, criterionId);
const counted = (counts: Readonly<Record<string, number>>): string => Object.entries(counts).map(([name, count]) => `${name}:${count}`).join(', ');

// Due times: the interval at 30, 60, 90 and 120; the timeout at 50, whose promise job runs
// straight after it and whose nested timeout comes due at 70; the two timeouts at 100 in the order
// they were registered. A timer due at exactly 120 ms is due within a 120 ms advance.
const RUN_TIMERS_LOG = [
  'interval-30@30', 'timeout-50@50', 'promise-after-timeout-50@50', 'interval-30@60', 'nested-timeout-20@70',
  'interval-30@90', 'timeout-100-first@100', 'timeout-100-second@100', 'interval-30@120',
].join(', ');
const RUN_TIMERS_COUNTS = counted({
  'interval-30': 4, 'timeout-50': 1, 'promise-after-timeout-50': 1, 'nested-timeout-20': 1, 'timeout-100-first': 1, 'timeout-100-second': 1,
});
// After the jump every timer due by 120 ms fires once, at 120 ms; the nested timeout the 50 ms
// timeout schedules then comes due at 140 ms, so it does not fire.
const SKIP_AHEAD_COUNTS = counted({
  'interval-30': 1, 'timeout-50': 1, 'promise-after-timeout-50': 1, 'nested-timeout-20': 0, 'timeout-100-first': 1, 'timeout-100-second': 1,
});
const NOTHING_RUN_COUNTS = counted({
  'interval-30': 0, 'timeout-50': 0, 'promise-after-timeout-50': 0, 'nested-timeout-20': 0, 'timeout-100-first': 0, 'timeout-100-second': 0,
});

for (const targetId of CDP_TARGETS) {
  describe(`timer order on ${targetId}`, () => {
    test('a 120 ms runTimers advance fires every due callback at its own time, in due-time order, ties in registration order', { criterion: 'AC-SPEC-34-06' }, async () => {
      const ran = await harness.runSteps(targetId, [
        navigate('/timer-order.html'),
        timerLog('(none)', 'timers.none-before-advance'),
        advanceClock(120, 'milliseconds', 'runTimers'),
        timerLog(RUN_TIMERS_LOG, 'timers.run-timers-order'),
        timerCounts(RUN_TIMERS_COUNTS, 'timers.run-timers-counts'),
      ]);
      assertPassed(ran);
    });

    test('an advance without a mode runs timers, as runTimers does', { criterion: 'AC-SPEC-34-06' }, async () => {
      const ran = await harness.runSteps(targetId, [
        navigate('/timer-order.html'), advanceClock(120, 'milliseconds'), timerLog(RUN_TIMERS_LOG, 'timers.default-mode-order'),
      ]);
      assertPassed(ran);
    });

    test('a 120 ms skipAhead advance fires each due timer once at the new time, the interval included', { criterion: 'AC-SPEC-34-06' }, async () => {
      const ran = await harness.runSteps(targetId, [
        navigate('/timer-order.html'),
        advanceClock(120, 'milliseconds', 'skipAhead'),
        timerCounts(SKIP_AHEAD_COUNTS, 'timers.skip-ahead-counts'),
        textEquals(testId('timer-times'), '120', 'timers.skip-ahead-time'),
      ]);
      assertPassed(ran);
    });
  });
}

test('two advances of 60 ms give the same order as one of 120 ms: a timer not yet due keeps its remaining delay', { criterion: 'AC-SPEC-34-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/timer-order.html'), advanceClock(60, 'milliseconds'), advanceClock(60, 'milliseconds'), timerLog(RUN_TIMERS_LOG, 'timers.split-order'),
  ]);
  assertPassed(ran);
});

test('counter-example: without an advance no timer has fired, so the order check fails', { criterion: 'AC-SPEC-34-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/timer-order.html'), timerCounts(NOTHING_RUN_COUNTS, 'timers.nothing-run'), timerLog(RUN_TIMERS_LOG, 'timers.never-advanced'),
  ]);
  assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'assertion-failed']]);
});

// ---- Timer loops that never end -----------------------------------------------------------------

const RUNAWAY_PAGES = [
  { name: 'a zero-delay timer loop', path: '/timer-loop.html' },
  { name: 'an endless animation-frame loop', path: '/animation-loop.html' },
] as const;

for (const { name, path } of RUNAWAY_PAGES) {
  test(`on ${name}, a one-hour runTimers advance fails with clock-runaway within the step timeout, and no later step sends input`, { criterion: 'AC-SPEC-34-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate(path),
      advanceClock(1, 'hours', 'runTimers'),
      click(role('button', 'Continue')),
      textEquals(testId('continue-state'), 'Continued', 'runaway.continued'),
    ], { read: ['input-events', 'continue-state'] });
    assert.equal(ran.result.state, 'Failed');
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'clock-runaway'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.ok(stepMilliseconds(ran.result, 1) < STEP_TIMEOUT_MILLISECONDS, `the advance failed after ${stepMilliseconds(ran.result, 1)} ms`);
    assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
    assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
  });
}

// One second is about 62 animation frames, far under the project's 10,000 callbacks per advance.
test('counter-example: a one-second advance on the animation-frame page runs its frames and passes', { criterion: 'AC-SPEC-34-07' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/animation-loop.html'),
    advanceClock(1, 'seconds', 'runTimers'),
    click(role('button', 'Continue')),
    textEquals(testId('continue-state'), 'Continued', 'runaway.short-advance-continued'),
  ], { read: ['frames-run'] });
  assertPassed(ran);
  const frames = Number(ran.atClose?.shown['frames-run']);
  assert.ok(frames >= 50 && frames <= 70, `about one frame per 16 ms of virtual time ran: ${String(ran.atClose?.shown['frames-run'])}`);
});
