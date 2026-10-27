// Report model, parser and maturity-level tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRODUCT } from '@revisum/contracts';
import { levelAt, metricsFor, parseHistory, parseReportInput, type History, type HistoryPeriod } from '@revisum/report';
import { byKind, loaded } from '../../support/report-fixtures.ts';

// Free-form access lets each case break the model in one place.
type Editable = Record<string, any>;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const codes = (input: unknown): string[] => {
  const parsed = parseReportInput(input);
  return parsed.ok ? [] : parsed.error.map((error) => `${error.path}:${error.code}`);
};

test('parseReportInput rejects each class of bad input with a typed error and a path', () => {
  const base = clone(byKind('functional')) as unknown as Editable;
  assert.equal(parseReportInput(base).ok, true, 'the unmodified model parses');
  const find = (breakIt: (broken: Editable) => void): string[] => { const broken = clone(base); breakIt(broken); return codes(broken); };
  assert.ok(find((broken) => { broken.findings[0].severity = 'P9'; }).some((code) => code.endsWith('severity:unknown_severity')));
  assert.ok(find((broken) => { broken.findings[0].caption = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'; }).some((code) => code.endsWith('caption:caption_too_long')));
  assert.ok(find((broken) => { broken.findings[0].image.imageId = 'nope'; }).some((code) => code.endsWith('imageId:unknown_image')));
  assert.ok(find((broken) => { broken.findings[0].stepIds = ['nope']; }).some((code) => code.endsWith('unknown_step')));
  assert.ok(find((broken) => { broken.findings[0].criterionIds = ['nope']; }).some((code) => code.endsWith('unknown_criterion')));
  assert.ok(find((broken) => { broken.findings[0].image.box = { x: 0, y: 0, width: -3, height: 4 }; }).some((code) => code.endsWith('width:out_of_range')));
  assert.ok(find((broken) => { broken.images[0].sha256 = 'abc'; }).some((code) => code.endsWith('sha256:bad_hash')));
  assert.ok(find((broken) => { broken.acceptance[0].stepIds = []; }).some((code) => code.endsWith('stepIds:criterion_without_steps')));
  assert.ok(find((broken) => { broken.acceptance[0].evidence = []; }).some((code) => code.endsWith('evidence:criterion_without_evidence')));
  assert.ok(find((broken) => { broken.extra = 1; }).some((code) => code.endsWith('extra:unknown_field')));
  assert.ok(find((broken) => { broken.findings[0].steps = ['only one']; }).some((code) => code.endsWith('steps:needs_two_steps')));
  assert.ok(find((broken) => { broken.findings[0].log = ['eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc']; }).some((code) => code.endsWith('secret_shape')));
  assert.ok(find((broken) => { broken.findings[0].log = ['Authorization: Bearer abcdefghijklmnop']; }).some((code) => code.endsWith('secret_shape')));
  assert.ok(find((broken) => { broken.findings[0].severity = null; }).some((code) => code.endsWith('failed_needs_severity')));
  assert.ok(find((broken) => { broken.findings.push(clone(broken.findings[0])); }).some((code) => code.endsWith('duplicate_id')));
  for (const junk of [null, undefined, 7, 'x', [], { schema: 'nope' }, () => 1, Symbol('s'), 10n]) assert.doesNotThrow(() => parseReportInput(junk));
  assert.equal(parseReportInput(null).ok, false);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.doesNotThrow(() => parseReportInput(cyclic));
});

test('parseHistory accepts the demo history and rejects broken ones', () => {
  const raw = clone(loaded.history) as unknown as Editable;
  assert.equal(parseHistory(raw).ok, true);
  const inconsistent = clone(raw);
  inconsistent.periods[0].changesVerifiedWithoutReview = 9999;
  assert.equal(parseHistory(inconsistent).ok, false);
  const empty = clone(raw);
  empty.periods = [];
  assert.equal(parseHistory(empty).ok, false);
  assert.equal(loaded.history.synthetic, true, 'the demo history is flagged synthetic');
});

// ---- Level table --------------------------------------------------------------------------------

type Row = {
  changes?: number; verified?: number; criteriaInScope?: number; criteriaTraced?: number; runs?: number; flaky?: number;
  escaped?: Partial<Record<'P1' | 'P2' | 'P3' | 'P4', number>>;
};
const period = (id: string, row: Row): HistoryPeriod => ({
  id, changes: row.changes ?? 100, changesVerifiedWithoutReview: row.verified ?? 0, criteriaInScope: row.criteriaInScope ?? 100,
  criteriaTraced: row.criteriaTraced ?? 0, runs: row.runs ?? 1000, flakyRuns: row.flaky ?? 0,
  escaped: { P1: 0, P2: 0, P3: 0, P4: 0, ...(row.escaped ?? {}) },
});
const history = (...rows: Row[]): History => ({
  schema: `${PRODUCT.schemaNamespace}.history/v1` as const, synthetic: true, label: 'test',
  periods: rows.map((row, index) => period(`T${index}`, row)),
});
const lastLevel = (periods: History): number => levelAt(periods, periods.periods.length - 1);
// A period that satisfies the level 4 thresholds exactly.
const LEVEL_FOUR: Row = { criteriaTraced: 95, verified: 80, flaky: 20 };

test('levelAt: level 0 and 1 thresholds at, just below and just above the boundary', () => {
  assert.equal(lastLevel(history({ criteriaTraced: 19 })), 0);
  assert.equal(lastLevel(history({ criteriaTraced: 20 })), 1);
  assert.equal(lastLevel(history({ criteriaTraced: 21 })), 1);
});

test('levelAt: level 2 needs traced >= 50% and verified >= 30%', () => {
  assert.equal(lastLevel(history({ criteriaTraced: 50, verified: 29 })), 1);
  assert.equal(lastLevel(history({ criteriaTraced: 49, verified: 30 })), 1);
  assert.equal(lastLevel(history({ criteriaTraced: 50, verified: 30 })), 2);
  assert.equal(lastLevel(history({ criteriaTraced: 51, verified: 31 })), 2);
});

test('levelAt: level 3 needs traced >= 80%, verified >= 60% and flaky <= 5%', () => {
  assert.equal(lastLevel(history({ criteriaTraced: 79, verified: 60, flaky: 50 })), 2);
  assert.equal(lastLevel(history({ criteriaTraced: 80, verified: 59, flaky: 50 })), 2);
  assert.equal(lastLevel(history({ criteriaTraced: 80, verified: 60, flaky: 51 })), 2, 'flaky 5.1% is above the limit');
  assert.equal(lastLevel(history({ criteriaTraced: 80, verified: 60, flaky: 50 })), 3, 'exactly 5.0% passes');
  assert.equal(lastLevel(history({ criteriaTraced: 81, verified: 61, flaky: 49 })), 3);
});

test('levelAt: level 4 thresholds and the 4-period escape window', () => {
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, criteriaTraced: 94 })), 3);
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, verified: 79 })), 3);
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, flaky: 21 })), 3, 'flaky 2.1% is above the limit');
  assert.equal(lastLevel(history(LEVEL_FOUR)), 4);
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, escaped: { P2: 1 } }, LEVEL_FOUR, LEVEL_FOUR, LEVEL_FOUR)), 3, 'a P2 escape inside the last 4 periods blocks level 4');
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, escaped: { P2: 1 } }, LEVEL_FOUR, LEVEL_FOUR, LEVEL_FOUR, LEVEL_FOUR)), 4, 'five periods ago is outside the window');
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, escaped: { P3: 9 } }, LEVEL_FOUR, LEVEL_FOUR, LEVEL_FOUR)), 4, 'a P3 escape does not block level 4');
  assert.equal(lastLevel(history({ ...LEVEL_FOUR, escaped: { P1: 1 } }, LEVEL_FOUR, LEVEL_FOUR, LEVEL_FOUR)), 3);
});

test('levelAt: level 5 needs 8 qualifying periods, verified >= 95% and no P1 to P3 escapes', () => {
  const LEVEL_FIVE: Row = { criteriaTraced: 98, verified: 95, flaky: 10 };
  const eight = Array.from({ length: 8 }, () => LEVEL_FIVE);
  assert.equal(lastLevel(history(...eight)), 5);
  assert.equal(lastLevel(history(...eight.slice(1))), 4, 'only 7 periods exist');
  assert.equal(lastLevel(history({ ...LEVEL_FIVE, verified: 94 }, ...eight.slice(1))), 4, 'verified 94% in one of the 8');
  assert.equal(lastLevel(history({ ...LEVEL_FIVE, escaped: { P3: 1 } }, ...eight.slice(1))), 4, 'a P3 escape in the 8-period window');
  assert.equal(lastLevel(history({ ...LEVEL_FIVE, escaped: { P4: 3 } }, ...eight.slice(1))), 5, 'P4 escapes do not block');
  assert.equal(lastLevel(history(LEVEL_FOUR, ...eight.slice(1))), 4, 'one period only at level 4 thresholds (verified 80%)');
  assert.equal(lastLevel(history({ ...LEVEL_FIVE, criteriaTraced: 90 }, ...eight.slice(1))), 4, 'one period below the level 4 traced threshold');
  assert.equal(lastLevel(history({ ...LEVEL_FIVE, criteriaTraced: 90 }, ...eight)), 5, 'the bad period is outside the last 8');
});

test('the level of every demo period is monotone here and the last one is 3', () => {
  const levels = loaded.history.periods.map((_, index) => levelAt(loaded.history, index));
  assert.deepEqual(levels, [0, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3]);
  const metrics = metricsFor(loaded.history.periods[11] as HistoryPeriod);
  assert.ok(metrics.tracedCriteriaShare > 0.8 && metrics.verifiedWithoutReviewShare > 0.6 && metrics.flakyRunRate <= 0.05);
});
