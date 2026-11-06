// What an advance leaves alone. Generated date values stay relative to the run's clock start and
// the plan clock, the page's frozen start time is the plan clock's, and the manifest keeps the
// run's own clock start and gains no field: the advance amounts are in the plan, so the plan hash
// already covers them. These runs use the recording driver, on which an advance fails with
// unsupported-step until the clock port lands; what the page sees after a real advance, and 20
// replays in the pinned Linux image, come with the CDP driver and replay.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FillValueKind, planHash, type PerformableAction } from '@revisum/engine';
import { DEFAULT_CLOCK_START, OPEN_ORDERS, runPlan, type JsonRecord } from './run-value-examples.ts';
import { COPY_LINK, accepted, advanceClock, expectClipboard, parserFor, planOf } from './clock-and-clipboard-examples.ts';

const VALUES: JsonRecord = {
  meetingDay: { kind: 'date', day: { from: 'startOfNextMonth', addDays: 0 }, format: 'longDate' },
  dueDate: { kind: 'date', day: { from: 'today', addDays: 14 }, format: 'yearMonthDay' },
};
const PLAN_CLOCK: JsonRecord = { day: { from: 'today', addDays: 1 }, time: '09:00' };
const fillWith = (label: string, valueName: string): JsonRecord => ({ type: 'fill', locator: { by: 'label', label }, value: { valueName } });
const FILLS = [fillWith('Meeting day', 'meetingDay'), fillWith('Due date', 'dueDate')];

// The same plan with and without advances after the date values are filled.
const withoutAdvances = (): JsonRecord => planOf([OPEN_ORDERS, ...FILLS], { values: VALUES, clock: PLAN_CLOCK });
const withAdvances = (): JsonRecord =>
  planOf([OPEN_ORDERS, ...FILLS, advanceClock(1, 'hours'), advanceClock(30, 'minutes', 'skipAhead')], { values: VALUES, clock: PLAN_CLOCK });

// The text each fill typed; a fill of anything but text is kept whole, so it fails the check.
const filledValues = (actions: readonly PerformableAction[]): unknown[] =>
  actions.flatMap((action) => (action.type === 'fill' ? [action.value.kind === FillValueKind.Text ? action.value.text : action.value] : []));

// ---- Date values and the clocks (metamorphic) -----------------------------------------------------------

test('date values filled in a plan with advances equal those of the same plan without them', async () => {
  const plain = await runPlan(withoutAdvances());
  const advanced = await runPlan(withAdvances());
  const plainValues = filledValues(plain.recording.actions);
  assert.equal(plainValues.length, 2, 'both date values were filled');
  assert.ok(plainValues.every((value) => typeof value === 'string' && value.length > 0), JSON.stringify(plainValues));
  assert.deepEqual(filledValues(advanced.recording.actions), plainValues);
});

test('the page starts at the same plan-clock time with and without advances', async () => {
  const plain = await runPlan(withoutAdvances());
  const advanced = await runPlan(withAdvances());
  const startTimes = (recording: typeof plain.recording) => recording.environments.map((environment) => environment.fixedTimeMilliseconds);
  assert.equal(startTimes(plain.recording).length, 1);
  assert.notEqual(startTimes(plain.recording)[0], DEFAULT_CLOCK_START, 'the plan clock moved the page away from the clock start');
  assert.deepEqual(startTimes(advanced.recording), startTimes(plain.recording));
});

test('the manifest records the run\'s own clock start, with and without advances', async () => {
  for (const raw of [withoutAdvances(), withAdvances()]) {
    const { result } = await runPlan(raw);
    assert.deepEqual(result.manifest?.clock, { fixedTimeMilliseconds: DEFAULT_CLOCK_START });
  }
});

// Counter-example: a different clock start does change the date values, so the equality above
// is not true of any two runs.
test('counter-example: a clock start 40 days later changes the date values', async () => {
  const plain = await runPlan(withoutAdvances());
  const later = await runPlan(withoutAdvances(), { clockStartMilliseconds: DEFAULT_CLOCK_START + 40 * 86_400_000 });
  assert.notDeepEqual(filledValues(later.recording.actions), filledValues(plain.recording.actions));
});

// ---- The plan hash and the manifest ---------------------------------------------------------------------

test('changing one advance amount changes the plan hash; parsing the same plan twice does not', () => {
  const parse = parserFor();
  const planWith = (seconds: number) => planOf([OPEN_ORDERS, advanceClock(599, 'seconds'), advanceClock(seconds, 'seconds'), COPY_LINK, expectClipboard('textContains', '/invite/')]);
  assert.equal(planHash(accepted(parse, planWith(1))), planHash(accepted(parse, planWith(1))));
  assert.notEqual(planHash(accepted(parse, planWith(1))), planHash(accepted(parse, planWith(2))));
});

test('changing an advance\'s mode or unit changes the plan hash', () => {
  const parse = parserFor();
  const hashOf = (step: JsonRecord) => planHash(accepted(parse, planOf([OPEN_ORDERS, step])));
  const hashes = new Set([hashOf(advanceClock(1, 'minutes')), hashOf(advanceClock(1, 'minutes', 'skipAhead')), hashOf(advanceClock(1, 'seconds'))]);
  assert.equal(hashes.size, 3);
});

const MANIFEST_FIELDS = ['adapter', 'browser', 'clock', 'engineVersion', 'fixtures', 'host', 'nonHermeticInputs', 'planHash', 'schema', 'seeds', 'target'];

test('the manifest of a run with advances and clipboard checks has exactly the fields of one without', async () => {
  const fieldsOf = (manifest: object | null): string[] => Object.keys(manifest ?? {}).sort();
  const plain = await runPlan(planOf([OPEN_ORDERS, COPY_LINK]));
  const advanced = await runPlan(planOf([OPEN_ORDERS, advanceClock(10, 'minutes'), COPY_LINK, expectClipboard('textContains', '/invite/')]));
  assert.deepEqual(fieldsOf(plain.result.manifest), MANIFEST_FIELDS);
  assert.deepEqual(fieldsOf(advanced.result.manifest), MANIFEST_FIELDS);
  assert.deepEqual(fieldsOf(advanced.result.manifest?.clock ?? null), ['fixedTimeMilliseconds']);
  assert.notEqual(advanced.result.manifest?.planHash, plain.result.manifest?.planHash);
});

test('20 runs of a plan with advances and clipboard checks give identical result and manifest hashes', async () => {
  const raw = planOf([OPEN_ORDERS, ...FILLS, advanceClock(599, 'seconds'), advanceClock(1, 'seconds'), COPY_LINK, expectClipboard('textContains', '/invite/')], { values: VALUES, clock: PLAN_CLOCK });
  const results = new Set<string>();
  const manifests = new Set<string | null>();
  for (let replay = 0; replay < 20; replay++) {
    const { result } = await runPlan(raw);
    results.add(result.resultHash);
    manifests.add(result.manifestHash);
  }
  assert.equal(results.size, 1);
  assert.equal(manifests.size, 1);
});
