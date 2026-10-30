// The plan clock in a real browser. A plan that sets `clock` freezes the page at the time
// resolvePlanClock gives, in the target's time zone, while the manifest keeps the run's own clock
// start. The fixture page (fixtures/plan-values-app/clock.html) shows its own Date.now() as it
// loads, and the plan checks it through the run's own oracle.
// 20 replays on each CDP target give one result hash. The replays share one browser per target,
// so the file stays quick: every replay still asks the driver for its session, and the test shows
// each asked with the same environment.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolvePlanClock } from '@revisum/engine';
import {
  CDP_TARGET, CDP_TARGETS, CLOCK_START_MILLISECONDS, navigate, planFor, planValuesHarness, reusedSessionDriver, testId, textEquals,
  type PlanValuesHarness,
} from './plan-values-support.ts';

let harness: PlanValuesHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

const FIRST_OF_NEXT_MONTH_AT_NINE = { day: { from: 'startOfNextMonth', addDays: 0 }, time: '09:00' };
// From 28 October 2026, 12:00 UTC, "the first of next month, 09:00" in London is 1 November,
// 09:00 GMT: summer time has ended by then.
const FIRST_OF_NOVEMBER_AT_NINE = Date.UTC(2026, 10, 1, 9, 0, 0);

const clockSteps = (expected: number) => [
  navigate('/clock.html'),
  textEquals(testId('page-now'), String(expected), 'clock.page-now-frozen'),
  textEquals(testId('page-time'), new Date(expected).toISOString(), 'clock.page-time-frozen'),
];

const clockedPlan = (targetId: string) => harness.plan(planFor(targetId, clockSteps(FIRST_OF_NOVEMBER_AT_NINE), { clock: FIRST_OF_NEXT_MONTH_AT_NINE }));

for (const targetId of CDP_TARGETS) {
  describe(`the plan clock on ${targetId}`, () => {
    test('the page\'s Date.now() is resolvePlanClock\'s time, and the manifest keeps the run\'s own clock start', { criterion: 'AC-SPEC-30-06' }, async () => {
      const plan = clockedPlan(targetId);
      assert.ok(plan.clock !== undefined, 'the parsed plan keeps its clock');
      // The expectation the page is checked against is resolvePlanClock's own answer.
      assert.equal(resolvePlanClock(plan.clock, CLOCK_START_MILLISECONDS, harness.target(targetId).timezone), FIRST_OF_NOVEMBER_AT_NINE);
      const { result } = await harness.run(plan, targetId);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.equal(result.manifest?.clock.fixedTimeMilliseconds, CLOCK_START_MILLISECONDS, 'the manifest records the run\'s own clock start');
    });

    test('20 replays of the plan give one result hash, each from the same session environment', { criterion: 'AC-SPEC-30-06', timeout: 180_000 }, async () => {
      const plan = clockedPlan(targetId);
      const adapter = harness.target(targetId).adapter;
      const inner = harness.drivers.get(adapter);
      assert.ok(inner !== undefined, `a driver for ${adapter}`);
      const reused = reusedSessionDriver(inner);
      const drivers = new Map([...harness.drivers, [adapter, reused.driver]]);
      const hashes = new Set<string>();
      try {
        for (let replay = 0; replay < 20; replay++) {
          const { result } = await harness.run(plan, targetId, { drivers });
          assert.equal(result.state, 'Passed', `replay ${replay}: ${JSON.stringify(result.steps)}`);
          hashes.add(result.resultHash);
        }
      } finally {
        await reused.closeAll();
      }
      assert.equal(hashes.size, 1, 'every replay gives the same result hash');
      assert.equal(reused.environments.length, 20, 'every replay asked for its session');
      for (const environment of reused.environments) assert.deepEqual(environment, reused.environments[0]);
      assert.equal(reused.environments[0]?.fixedTimeMilliseconds, FIRST_OF_NOVEMBER_AT_NINE, 'the session is frozen at the plan clock');
    });
  });
}

// Counter-example: without a plan clock the page shows the run's own clock start, so the checks
// above see the plan clock and not a constant the page always shows.
test('without a plan clock, the page\'s Date.now() is the run\'s clock start', { criterion: 'AC-SPEC-30-06' }, async () => {
  const { result } = await harness.runSteps(CDP_TARGET, clockSteps(CLOCK_START_MILLISECONDS));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
});

// A second clock start moves the page's time with it: the plan clock is relative, not fixed.
test('a clock start a month later freezes the page at the first of the month after that', { criterion: 'AC-SPEC-30-06' }, async () => {
  const laterStart = Date.UTC(2026, 10, 20, 12, 0, 0);
  // 1 December 2026, 09:00 in London is 09:00 UTC.
  const firstOfDecemberAtNine = Date.UTC(2026, 11, 1, 9, 0, 0);
  const plan = harness.plan(planFor(CDP_TARGET, clockSteps(firstOfDecemberAtNine), { clock: FIRST_OF_NEXT_MONTH_AT_NINE }));
  const { result } = await harness.run(plan, CDP_TARGET, { clockStartMilliseconds: laterStart });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.equal(result.manifest?.clock.fixedTimeMilliseconds, laterStart);
});
