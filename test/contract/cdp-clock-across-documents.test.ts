// One run has one virtual time, on the own CDP driver. A plan sets a plan clock, advances it, and
// then loads new documents: by navigating, by opening a newTab and by entering a frame whose page
// loads after the advance. Each new document's Date.now(), shown as it loads
// (fixtures/clock-and-clipboard-app/clock.html), is the plan clock plus every earlier advance.
// An advance inside a newTab block moves the first tab's clock too, and an advance moves a frame
// that had already loaded. The counter-examples show the same checks fail without the advance.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolvePlanClock } from '@revisum/engine';
import {
  CDP_TARGET, CLOCK_START_MILLISECONDS, HOUR, MINUTE, advanceClock, click, clockHarness, clockPlan, frame, navigate, newTab, outcomes, role,
  testId, textEquals, type ClockHarness, type ClockRun, type JsonRecord,
} from './clock-and-clipboard-support.ts';

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: ClockRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));

const FIRST_OF_NEXT_MONTH_AT_NINE: JsonRecord = { day: { from: 'startOfNextMonth', addDays: 0 }, time: '09:00' };
// From 30 October 2026, 12:00 UTC, "the first of next month, 09:00" in London is 1 November,
// 09:00 GMT: summer time has ended by then.
const PLAN_CLOCK = Date.UTC(2026, 10, 1, 9, 0, 0);
const ADVANCED = HOUR + 30 * MINUTE;

const loadedAt = (milliseconds: number, criterionId: string) => textEquals(testId('page-now'), String(milliseconds), criterionId);
const nowOnRequest = (milliseconds: number, criterionId: string) => textEquals(testId('now-on-request'), String(milliseconds), criterionId);
const showNow = click(role('button', 'Show the time now'));
const clockFrame = (steps: readonly unknown[]) => frame(testId('clock-frame'), steps);
const withPlanClock = { fields: { clock: FIRST_OF_NEXT_MONTH_AT_NINE } };

test('the plan clock the checks expect is resolvePlanClock\'s own answer', { criterion: 'AC-SPEC-34-09' }, () => {
  const plan = harness.plan(clockPlan(CDP_TARGET, [navigate('/clock.html'), loadedAt(PLAN_CLOCK, 'documents.plan-clock')], { clock: FIRST_OF_NEXT_MONTH_AT_NINE }));
  assert.ok(plan.clock !== undefined);
  assert.equal(resolvePlanClock(plan.clock, CLOCK_START_MILLISECONDS, harness.target(CDP_TARGET).timezone), PLAN_CLOCK);
});

describe('documents loaded after an advance', () => {
  test('a navigation, a newTab and a frame loaded after advances each start at the plan clock plus every earlier advance', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock.html'),
      loadedAt(PLAN_CLOCK, 'documents.first-at-plan-clock'),
      advanceClock(1, 'hours'),
      advanceClock(30, 'minutes'),
      navigate('/clock.html'),
      loadedAt(PLAN_CLOCK + ADVANCED, 'documents.navigation-advanced'),
      newTab('/clock.html', [loadedAt(PLAN_CLOCK + ADVANCED, 'documents.tab-advanced')]),
      navigate('/clock-frame.html'),
      clockFrame([loadedAt(PLAN_CLOCK + ADVANCED, 'documents.frame-advanced')]),
    ], withPlanClock);
    assertPassed(ran);
  });

  test('an advance inside a newTab block moves the tab\'s clock and the first tab\'s clock, and a later navigation starts there', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock.html'),
      newTab('/clock.html', [
        loadedAt(PLAN_CLOCK, 'documents.tab-at-plan-clock'),
        advanceClock(1, 'hours'),
        showNow,
        nowOnRequest(PLAN_CLOCK + HOUR, 'documents.tab-moved'),
      ]),
      showNow,
      nowOnRequest(PLAN_CLOCK + HOUR, 'documents.first-tab-moved'),
      navigate('/clock.html'),
      loadedAt(PLAN_CLOCK + HOUR, 'documents.later-navigation-moved'),
    ], withPlanClock);
    assertPassed(ran);
  });

  test('an advance moves a frame that loaded before it', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock-frame.html'),
      clockFrame([loadedAt(PLAN_CLOCK, 'documents.frame-at-plan-clock')]),
      advanceClock(45, 'minutes'),
      clockFrame([showNow, nowOnRequest(PLAN_CLOCK + 45 * MINUTE, 'documents.loaded-frame-moved')]),
    ], withPlanClock);
    assertPassed(ran);
  });

  test('without a plan clock, a document loaded after an advance starts at the run\'s clock start plus the advance', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock.html'),
      loadedAt(CLOCK_START_MILLISECONDS, 'documents.first-at-clock-start'),
      advanceClock(20, 'minutes'),
      navigate('/clock.html'),
      loadedAt(CLOCK_START_MILLISECONDS + 20 * MINUTE, 'documents.navigation-after-clock-start'),
    ]);
    assertPassed(ran);
  });
});

describe('counter-examples', () => {
  test('without the advance inside the tab, the first tab still shows the plan clock, so the check for the moved clock fails', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock.html'),
      newTab('/clock.html', [loadedAt(PLAN_CLOCK, 'documents.tab-unmoved')]),
      showNow,
      nowOnRequest(PLAN_CLOCK + HOUR, 'documents.first-tab-not-moved'),
    ], withPlanClock);
    assert.deepEqual(outcomes(ran.result).at(-1), [3, 'failed', 'assertion-failed'], JSON.stringify(ran.result.steps));
  });

  test('a newTab opened without an earlier advance starts at the plan clock, not later', { criterion: 'AC-SPEC-34-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/clock.html'),
      newTab('/clock.html', [loadedAt(PLAN_CLOCK + ADVANCED, 'documents.tab-not-advanced')]),
    ], withPlanClock);
    assert.equal(ran.result.state, 'Failed', JSON.stringify(ran.result.steps));
  });
});
