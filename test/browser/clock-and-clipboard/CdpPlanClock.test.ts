// The plan clock in a real browser. A plan that sets `clock` freezes the page at the time
// resolvePlanClock gives, in the target's time zone, while the manifest keeps the run's own clock
// start. The fixture page (test/fixtures/sites/plan-values-app/clock.html) shows its own Date.now() as it
// loads, and the plan checks it through the run's own oracle.
// Replays on each CDP target give one result hash. The replays share one browser per target,
// so the file stays quick: every replay still asks the driver for its session, and the test shows
// each asked with the same environment.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolvePlanClock } from '@revisum/engine';
import { determinismRuns, onTarget } from '#test-support/TestTier.ts';
import type { BrowserHarness } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { navigate, testId, textEquals } from '#test-support/browser/RawPlan.ts';
import { reusedSessionDriver } from '#test-support/browser/driver/ReusedSessionDriver.ts';
import { CLOCK_START_MILLISECONDS, planFor, planValuesHarness } from '../values/support/PlanValuesHarness.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';

shareBrowserInThisFile();

let harness: BrowserHarness;
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

for (const targetId of Object.values(BrowserTarget)) {
  describe(`the plan clock on ${targetId}`, () => {
    test('the page\'s Date.now() is resolvePlanClock\'s time, and the manifest keeps the run\'s own clock start', onTarget(targetId), async () => {
      const plan = clockedPlan(targetId);
      assert.ok(plan.clock !== undefined, 'the parsed plan keeps its clock');
      // The expectation the page is checked against is resolvePlanClock's own answer.
      assert.equal(resolvePlanClock(plan.clock, CLOCK_START_MILLISECONDS, harness.target(targetId).timezone), FIRST_OF_NOVEMBER_AT_NINE);
      const { result } = await harness.run(plan, targetId);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.equal(result.manifest.clock.fixedTimeMilliseconds, CLOCK_START_MILLISECONDS, 'the manifest records the run\'s own clock start');
    });

    test(`${determinismRuns()} replays of the plan give one result hash, each from the same session environment`, { timeout: 180_000, ...onTarget(targetId) }, async () => {
      const plan = clockedPlan(targetId);
      const adapter = harness.target(targetId).adapter;
      const inner = harness.drivers.get(adapter);
      assert.ok(inner !== undefined, `a driver for ${adapter}`);
      const reused = reusedSessionDriver(inner);
      const drivers = new Map([...harness.drivers, [adapter, reused.driver]]);
      const hashes = new Set<string>();
      try {
        for (let replay = 0; replay < determinismRuns(); replay++) {
          const { result } = await harness.run(plan, targetId, { drivers });
          assert.equal(result.state, 'Passed', `replay ${replay}: ${JSON.stringify(result.steps)}`);
          hashes.add(result.resultHash);
        }
      } finally {
        await reused.closeAll();
      }
      assert.equal(hashes.size, 1, 'every replay gives the same result hash');
      assert.equal(reused.environments.length, determinismRuns(), 'every replay asked for its session');
      for (const environment of reused.environments) {assert.deepEqual(environment, reused.environments[0]);}
      assert.equal(reused.environments[0]?.fixedTimeMilliseconds, FIRST_OF_NOVEMBER_AT_NINE, 'the session is frozen at the plan clock');
    });
  });
}

// Counter-example: without a plan clock the page shows the run's own clock start, so the checks
// above see the plan clock and not a constant the page always shows.
test('without a plan clock, the page\'s Date.now() is the run\'s clock start', async () => {
  const { result } = await harness.runSteps(BrowserTarget.Chrome, clockSteps(CLOCK_START_MILLISECONDS));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
});

// A second clock start moves the page's time with it: the plan clock is relative, not fixed.
test('a clock start a month later freezes the page at the first of the month after that', async () => {
  const laterStart = Date.UTC(2026, 10, 20, 12, 0, 0);
  // 1 December 2026, 09:00 in London is 09:00 UTC.
  const firstOfDecemberAtNine = Date.UTC(2026, 11, 1, 9, 0, 0);
  const plan = harness.plan(planFor(BrowserTarget.Chrome, clockSteps(firstOfDecemberAtNine), { clock: FIRST_OF_NEXT_MONTH_AT_NINE }));
  const { result } = await harness.run(plan, BrowserTarget.Chrome, { clockStartMilliseconds: laterStart });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.equal(result.manifest.clock.fixedTimeMilliseconds, laterStart);
});
