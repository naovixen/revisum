// Until the determinism kit tracks timers and the CDP driver carries the clock and clipboard ports
// (SPEC-06 and SPEC-08), runs report every step of this spec as failed with unsupported-step: an
// advanceClock in either mode, an expectClipboard of each kind and a remember from the clipboard.
// The step never gives a partial result and never falls back to a real wait: nothing of it
// reaches the driver, no timer as long as the advance is started, and every later step is
// skipped. The counter-example runs the same plan without the step and does reach the driver.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { OPEN_ORDERS, ORIGIN, runPlan, type JsonRecord } from './run-value-examples.ts';
import { COPY_LINK, HOUR, advanceClock, expectClipboard, planOf, rememberClipboard } from './clock-and-clipboard-examples.ts';

const AFTER: JsonRecord = { type: 'click', locator: { by: 'role', role: 'button', name: 'Continue' } };

const FEATURES: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'an advanceClock in the default mode', step: advanceClock(1, 'hours') },
  { name: 'an advanceClock in runTimers mode', step: advanceClock(1, 'hours', 'runTimers') },
  { name: 'an advanceClock in skipAhead mode', step: advanceClock(1, 'hours', 'skipAhead') },
  { name: 'an expectClipboard with textEquals', step: expectClipboard('textEquals', 'https://example.test/invite/abc') },
  { name: 'an expectClipboard with multi-line textEquals', step: expectClipboard('textEquals', { lines: ['Ada Lovelace', 'London'] }) },
  { name: 'an expectClipboard with textContains', step: expectClipboard('textContains', '/invite/') },
  { name: 'an expectClipboard with textExcludes', step: expectClipboard('textExcludes', 'password') },
  { name: 'a remember from the clipboard', step: rememberClipboard('inviteLink') },
];

// What the driver was asked, other than opening the session.
const reached = (recording: { readonly navigations: readonly string[]; readonly actions: readonly unknown[]; readonly probes: number }) =>
  ({ navigations: recording.navigations, actions: recording.actions.length, probes: recording.probes });

// Every real timer the run starts, by its delay, so a test can see that no advance becomes a wait.
let timerDelays: number[] = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
beforeEach(() => {
  timerDelays = [];
  const recordTimeout = (handler: () => void, delay?: number, ...rest: unknown[]) => {
    timerDelays.push(delay ?? 0);
    return realSetTimeout(handler, delay, ...rest);
  };
  const recordInterval = (handler: () => void, delay?: number, ...rest: unknown[]) => {
    timerDelays.push(delay ?? 0);
    return realSetInterval(handler, delay, ...rest);
  };
  globalThis.setTimeout = Object.assign(recordTimeout, realSetTimeout) as typeof setTimeout;
  globalThis.setInterval = Object.assign(recordInterval, realSetInterval) as typeof setInterval;
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
});

for (const { name, step } of FEATURES) {
  test(`a run with ${name} fails that step with unsupported-step, sends nothing of it and skips the rest`, { criterion: 'AC-SPEC-34-12' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, step, AFTER]));
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.type, stepResult.outcome, stepResult.code]), [
      [0, 'navigate', 'passed', undefined], [1, String(step['type']), 'failed', 'unsupported-step'],
      [2, 'click', 'skipped', undefined], [3, 'expect', 'skipped', undefined],
    ]);
    assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 }, 'only the first navigation reached the driver');
  });
}

test('an unsupported advance of one hour waits no real time: no timer near its length is started and the run ends at once', { criterion: 'AC-SPEC-34-12' }, async () => {
  const started = performance.now();
  const { result } = await runPlan(planOf([OPEN_ORDERS, advanceClock(1, 'hours'), AFTER]));
  const elapsed = performance.now() - started;
  assert.equal(result.steps[1]?.code, 'unsupported-step');
  assert.ok(elapsed < 10_000, `the run took ${Math.round(elapsed)} ms`);
  assert.deepEqual(timerDelays.filter((delay) => delay >= HOUR / 2), [], 'no timer of half the advance or more');
});

// Mutant: the timer record does see a long timer, so the empty list above can fail.
test('mutant: a timer as long as the advance is seen by the timer record', { criterion: 'AC-SPEC-34-12' }, () => {
  const timer = setTimeout(() => undefined, HOUR);
  clearTimeout(timer);
  assert.deepEqual(timerDelays.filter((delay) => delay >= HOUR / 2), [HOUR]);
});

// Counter-example: the same run without any of those steps clicks and checks the page, and passes.
test('counter-example: the same run without any of those steps clicks and checks the page, and passes', { criterion: 'AC-SPEC-34-12' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, AFTER]));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`]);
  assert.deepEqual(recording.actions.map((action) => action.type), ['click']);
  assert.ok(recording.probes > 0, 'the closing check read the page');
});

// A copy, then a clipboard check: the copy click is performed, the check is not, and a fill that
// uses a value remembered from the clipboard is skipped, never sent with empty text.
test('after a copy click, a clipboard remember fails with unsupported-step and the fill that uses it is skipped', { criterion: 'AC-SPEC-34-12' }, async () => {
  const fill = { type: 'fill', locator: { by: 'label', label: 'Invite link' }, value: { valueName: 'inviteLink' } };
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, COPY_LINK, rememberClipboard('inviteLink'), fill]));
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.outcome, stepResult.code]), [
    [0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'unsupported-step'], [3, 'skipped', undefined], [4, 'skipped', undefined],
  ]);
  assert.deepEqual(recording.actions.map((action) => action.type), ['click']);
});

test('an advance before the first navigation fails with unsupported-step and the page is never loaded', { criterion: 'AC-SPEC-34-12' }, async () => {
  const { result, recording } = await runPlan(planOf([advanceClock(10, 'minutes'), OPEN_ORDERS]));
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((stepResult) => [stepResult.index, stepResult.outcome, stepResult.code]), [
    [0, 'failed', 'unsupported-step'], [1, 'skipped', undefined], [2, 'skipped', undefined],
  ]);
  assert.deepEqual(recording.navigations, []);
});
