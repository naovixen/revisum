// The plan clock: a plan may set the page's frozen clock relative to the run's clock start, in the
// target's time zone, such as "the first of next month, 09:00". The page sees that time; the
// manifest keeps the run's own clock start, so replays stay identical.
// The page's own Date.now() comes from the time the driver is given: the driver contract
// (test/contract/driver-contract.test.ts) proves a session's page reports exactly that time.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePlanClock } from '@revisum/engine';
import {
  OPEN_ORDERS, PAGE_TITLE, accepted, parserFor, planOf, projectFileWith, projectWith, rejection, runPlan,
  type JsonRecord,
} from './run-value-examples.ts';

const CLOCK_START = Date.UTC(2026, 9, 28, 12, 0, 0);
const FIRST_OF_NEXT_MONTH_AT_NINE: JsonRecord = { day: { from: 'startOfNextMonth', addDays: 0 }, time: '09:00' };

// A project whose only target is in `timezone`.
const projectFileIn = (timezone: string): JsonRecord => {
  const file = projectFileWith();
  const matrix = (file['matrix'] as JsonRecord[]).map((target) => ({ ...target, timezone, locale: 'en-GB' }));
  return { ...file, matrix };
};

function planClockIn(timezone: string, clock: JsonRecord) {
  const project = projectWith({ matrix: projectFileIn(timezone)['matrix'] });
  const plan = accepted(parserFor({ matrix: projectFileIn(timezone)['matrix'] }), planOf([], { clock }));
  const target = project.matrix[0];
  assert.ok(target !== undefined);
  return { clock: plan.clock, timezone: target.timezone };
}

// ---- resolvePlanClock ---------------------------------------------------------------------------

test('without a plan clock, the page time is the run\'s clock start', { criterion: 'AC-SPEC-30-06' }, () => {
  const { timezone } = planClockIn('Europe/London', FIRST_OF_NEXT_MONTH_AT_NINE);
  assert.equal(resolvePlanClock(undefined, CLOCK_START, timezone), CLOCK_START);
});

const CLOCK_CASES = [
  { timezone: 'Europe/London', clockStart: CLOCK_START, expected: Date.UTC(2026, 10, 1, 9, 0), why: 'Greenwich time in November' },
  { timezone: 'Asia/Tokyo', clockStart: CLOCK_START, expected: Date.UTC(2026, 10, 1, 0, 0), why: 'nine hours ahead' },
  { timezone: 'America/Los_Angeles', clockStart: CLOCK_START, expected: Date.UTC(2026, 10, 1, 17, 0), why: 'summer time ended earlier that morning' },
  { timezone: 'Europe/London', clockStart: Date.UTC(2026, 2, 15, 12, 0), expected: Date.UTC(2026, 3, 1, 8, 0), why: 'summer time began in between' },
] as const;

for (const clockCase of CLOCK_CASES) {
  test(`"the first of next month, 09:00" in ${clockCase.timezone} from ${new Date(clockCase.clockStart).toISOString()} is ${new Date(clockCase.expected).toISOString()} (${clockCase.why})`, { criterion: 'AC-SPEC-30-06' }, () => {
    const { clock, timezone } = planClockIn(clockCase.timezone, FIRST_OF_NEXT_MONTH_AT_NINE);
    assert.ok(clock !== undefined, 'the parsed plan keeps its clock');
    assert.equal(resolvePlanClock(clock, clockCase.clockStart, timezone), clockCase.expected);
  });
}

test('a clock time of "00:00" and "23:59" is accepted; "24:00", "9:00", "09:60" and "09:00:00" are refused at the time', { criterion: 'AC-SPEC-30-06' }, () => {
  const parse = parserFor();
  const withTime = (time: string): JsonRecord => planOf([], { clock: { day: { from: 'today', addDays: 0 }, time } });
  for (const time of ['00:00', '23:59']) accepted(parse, withTime(time));
  for (const time of ['24:00', '9:00', '09:60', '09:00:00']) {
    const errors = rejection(parse, withTime(time));
    assert.equal(errors.length, 1, `${time}: ${JSON.stringify(errors)}`);
    assert.ok(errors[0]?.endsWith(' $.clock.time'), `${time}: ${JSON.stringify(errors)}`);
  }
});

// ---- In a run -----------------------------------------------------------------------------------

const clockedPlan = planOf([OPEN_ORDERS, { type: 'expectPage', assert: { kind: 'title', value: PAGE_TITLE }, criterionId: 'orders.page-titled' }], {
  clock: FIRST_OF_NEXT_MONTH_AT_NINE,
});

test('with a plan clock, the driver freezes the page at resolvePlanClock\'s time and the manifest keeps the run\'s clock start', { criterion: 'AC-SPEC-30-06' }, async () => {
  const projectFile = projectFileIn('Europe/London');
  const { result, recording } = await runPlan(clockedPlan, { projectFile, clockStartMilliseconds: CLOCK_START });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.environments.map((environment) => environment.fixedTimeMilliseconds), [Date.UTC(2026, 10, 1, 9, 0)]);
  const { clock, timezone } = planClockIn('Europe/London', FIRST_OF_NEXT_MONTH_AT_NINE);
  assert.equal(recording.environments[0]?.fixedTimeMilliseconds, resolvePlanClock(clock, CLOCK_START, timezone));
  assert.equal(result.manifest?.clock.fixedTimeMilliseconds, CLOCK_START, 'the manifest records the run\'s own clock start');
});

// Counter-example: without a plan clock the page is frozen at the run's clock start, as before.
test('without a plan clock, the driver freezes the page at the run\'s clock start', { criterion: 'AC-SPEC-30-06' }, async () => {
  const { clock: _removed, ...unclocked } = clockedPlan;
  const { recording } = await runPlan(unclocked, { projectFile: projectFileIn('Europe/London'), clockStartMilliseconds: CLOCK_START });
  assert.deepEqual(recording.environments.map((environment) => environment.fixedTimeMilliseconds), [CLOCK_START]);
});

test('20 replays of a plan with a plan clock give identical result and manifest hashes', { criterion: 'AC-SPEC-30-06' }, async () => {
  const projectFile = projectFileIn('Europe/London');
  const hashes = new Set<string>();
  const manifests = new Set<string | null>();
  for (let replay = 0; replay < 20; replay++) {
    const { result } = await runPlan(clockedPlan, { projectFile, clockStartMilliseconds: CLOCK_START });
    assert.equal(result.state, 'Passed');
    hashes.add(result.resultHash);
    manifests.add(result.manifestHash);
  }
  assert.equal(hashes.size, 1);
  assert.equal(manifests.size, 1);
});
