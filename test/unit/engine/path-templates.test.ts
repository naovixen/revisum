// Path templates: navigate may build a path from literal segments, run values and query values.
// Each value is percent-encoded as one whole segment or query value, and the origin is always the
// run's base URL, so no value can change where the browser goes or how many segments the path has.
// Here the values are unique texts whose prefixes hold "/", "?", "#", "%2F", "..", spaces and
// non-Latin text, run through run() on a recording driver.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPEN_ORDERS, ORIGIN, PAGE_TITLE, accepted, navigate, parserFor, planOf, reference, rejection, runPlan,
  type JsonRecord,
} from './run-value-examples.ts';

const parsePlan = parserFor();

// Ten prefixes, each run with 100 seeds: 1,000 generated values.
const HOSTILE_PREFIXES = ['/', '?', '#', '%2F', '..', 'two words', '名前', '../../admin', 'a/b?c=d#e', 'https://elsewhere.example'];
const SEEDS_PER_PREFIX = 100;

const TEMPLATE: JsonRecord = { segments: ['orders', reference('orderCode'), 'items'], query: { search: reference('orderCode'), page: '2' } };
const templatePlan = (prefix: string): JsonRecord => planOf(
  [navigate(TEMPLATE), { type: 'expectPage', assert: { kind: 'title', value: PAGE_TITLE }, criterionId: 'orders.page-titled' }],
  { values: { orderCode: { kind: 'uniqueText', prefix } } },
);

test('1,000 generated values keep the base URL\'s origin and exactly three path segments, each value decoding to itself', { criterion: 'AC-SPEC-30-11', timeout: 300_000 }, async () => {
  let checked = 0;
  for (const prefix of HOSTILE_PREFIXES) {
    for (let seed = 0; seed < SEEDS_PER_PREFIX; seed++) {
      const { result, recording } = await runPlan(templatePlan(prefix), { seed });
      assert.equal(result.state, 'Passed', `${prefix} with seed ${seed}: ${JSON.stringify(result.steps)}`);
      assert.equal(recording.navigations.length, 1);
      const url = new URL(recording.navigations[0] ?? '');
      assert.equal(url.origin, ORIGIN, `${prefix} with seed ${seed}`);
      const segments = url.pathname.split('/').slice(1);
      assert.equal(segments.length, 3, `${prefix} with seed ${seed}: ${url.pathname}`);
      assert.equal(segments[0], 'orders');
      assert.equal(segments[2], 'items');
      const value = decodeURIComponent(segments[1] ?? '');
      assert.ok(value.startsWith(`${prefix}-`), `${prefix} with seed ${seed}: decoded ${value}`);
      assert.equal(url.searchParams.get('search'), value, 'the query value is the same whole value');
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.hash, '', 'no value starts a fragment');
      checked++;
    }
  }
  assert.equal(checked, 1000);
});

test('two seeds put two different values into the same template', { criterion: 'AC-SPEC-30-11' }, async () => {
  const first = await runPlan(templatePlan('order'), { seed: 1 });
  const second = await runPlan(templatePlan('order'), { seed: 2 });
  assert.notEqual(first.recording.navigations[0], second.recording.navigations[0]);
  assert.equal(new URL(first.recording.navigations[0] ?? '').origin, new URL(second.recording.navigations[0] ?? '').origin);
});

for (const character of ['/', '?', '#']) {
  test(`a literal segment holding "${character}" is refused at parse time with unknown_value at that segment`, { criterion: 'AC-SPEC-30-11' }, () => {
    const plan = planOf([navigate({ segments: ['orders', `latest${character}admin`] })]);
    assert.deepEqual(rejection(parsePlan, plan), ['unknown_value $.steps[0].url.segments[1]']);
  });
}

for (const segment of ['.', '..']) {
  test(`a literal segment written as "${segment}" is refused at parse time with invalid_url at that segment`, { criterion: 'AC-SPEC-30-11' }, () => {
    const plan = planOf([navigate({ segments: ['orders', segment, 'admin'] })]);
    assert.deepEqual(rejection(parsePlan, plan), ['invalid_url $.steps[0].url.segments[1]']);
  });
}

// Counter-example: dots inside a longer literal segment are ordinary text.
test('a literal segment such as "v1.2" or "...more" is accepted', { criterion: 'AC-SPEC-30-11' }, () => {
  accepted(parsePlan, planOf([navigate({ segments: ['docs', 'v1.2', '...more'] })]));
});

test('a query key outside letters, digits, "_", "." and "-" is refused', { criterion: 'AC-SPEC-30-11' }, () => {
  // Control: the same template with a valid key is accepted, so the refusals below are the key's.
  accepted(parsePlan, planOf([navigate({ segments: ['orders'], query: { search: 'shoes' } })]));
  rejection(parsePlan, planOf([navigate({ segments: ['orders'], query: { 'search term': 'shoes' } })]));
  rejection(parsePlan, planOf([navigate({ segments: ['orders'], query: { ['a'.repeat(65)]: 'shoes' } })]));
});

// Counter-example: literal segments and query values without separators are accepted, and a
// literal query value may hold any safe text, since it is encoded as a whole.
test('a template of plain literal segments, with query values holding "/" and "?", is accepted', { criterion: 'AC-SPEC-30-11' }, () => {
  accepted(parsePlan, planOf([navigate({ segments: ['orders', 'latest'], query: { search: 'a/b?c', 'page.size': '20' } })]));
});

test('a literal path template navigates to its literal path on the base URL', { criterion: 'AC-SPEC-30-11' }, async () => {
  const { recording } = await runPlan(planOf([navigate({ segments: ['orders', 'two words'] }), OPEN_ORDERS]));
  assert.equal(recording.navigations[0], `${ORIGIN}/orders/two%20words`);
});
