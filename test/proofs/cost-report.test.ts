// Hosted spend at zero customers stays at or under USD 5 a month. There is no billing access, so
// spend is the declared record docs/costs/hosted-costs.json: the month, the customer count and
// one line per hosted service with its monthly cost in USD. `npm run cost-report` prints the
// month's report and fails when the total is over USD 5 while there are no customers; the lint
// runs the same check, so a committed record over budget fails CI.
// Each test rewrites the record in a throw-away copy of the repository. The record's fields are
// found by shape (the list of service lines, each line's one number, the top-level count), so
// the tests fix the budget rule and not the field names.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, lintWithEdits, withEdits } from './scratch-edits.ts';

const RECORD_PATH = 'docs/costs/hosted-costs.json';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const numberKeys = (value: JsonObject): string[] => Object.keys(value).filter((key) => typeof value[key] === 'number');

// The record's list of service lines: its only top-level list of objects.
function serviceLinesKey(record: JsonObject): string {
  const keys = Object.keys(record).filter((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 0 && value.every(isObject);
  });
  assert.equal(keys.length, 1, `${RECORD_PATH} should hold exactly one list of service lines, found: ${keys.join(', ')}`);
  return keys[0] ?? '';
}

// The record rewritten with one service line per amount, and optionally another customer count.
function recordWith(amounts: readonly number[], customers?: number): (text: string) => string {
  return (text) => {
    const record: JsonObject = JSON.parse(text);
    const key = serviceLinesKey(record);
    const lines = record[key] as JsonObject[];
    const template = lines[0] ?? {};
    const [costKey, ...otherNumbers] = numberKeys(template);
    assert.ok(costKey !== undefined && otherNumbers.length === 0, `a service line should hold exactly one number, its monthly cost: ${JSON.stringify(template)}`);
    record[key] = amounts.map((amount) => ({
      ...template,
      [costKey]: amount,
    }));
    if (customers !== undefined) {
      const [customersKey, ...others] = numberKeys(record);
      assert.ok(customersKey !== undefined && others.length === 0, `the record should hold exactly one top-level number, the customer count: ${text}`);
      record[customersKey] = customers;
    }
    return `${JSON.stringify(record, null, 2)}\n`;
  };
}

// Runs the cost-report script from package.json in the copy.
function costReport(): ToolRun {
  const manifest: { readonly scripts?: Readonly<Record<string, string>> } = JSON.parse(readFileSync(join(scratch.root, 'package.json'), 'utf8'));
  const words = (manifest.scripts?.['cost-report'] ?? '').trim().split(/\s+/);
  assert.equal(words[0], 'node', 'package.json has no "cost-report" script that runs node');
  return runTool(join(scratch.root, words[1] ?? ''), words.slice(2), { cwd: scratch.root });
}

// ---- The committed record -----------------------------------------------------------------------

test('the committed record declares zero customers and a total within the budget', { criterion: 'AC-SPEC-00-09' }, () => {
  const run = costReport();
  assert.equal(run.passed, true, describeRun(run));
  const record: JsonObject = JSON.parse(readFileSync(join(scratch.root, RECORD_PATH), 'utf8'));
  const [customersKey] = numberKeys(record);
  assert.equal(customersKey === undefined ? undefined : record[customersKey], 0);
  assert.ok(JSON.stringify(record).includes('"declared"'), 'each service line is marked as declared');
});

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-09', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- The budget ---------------------------------------------------------------------------------

test('the lint fails on a record totalling USD 5.01 at zero customers', { criterion: 'AC-SPEC-00-09', timeout: TIMEOUT }, () => {
  assertLintFails(lintWithEdits(scratch, { [RECORD_PATH]: recordWith([2.5, 2.51], 0) }), ['hosted-costs.json']);
});

test('the cost report fails on a record totalling USD 5.01 at zero customers, and prints the total', { criterion: 'AC-SPEC-00-09' }, () => {
  const run = withEdits(scratch.root, { [RECORD_PATH]: recordWith([2.5, 2.51], 0) }, costReport);
  assert.equal(run.passed, false, describeRun(run));
  assert.ok(run.output.includes('5.01'), describeRun(run));
});

test('counter-example: a record totalling exactly USD 5 passes the lint and the report', { criterion: 'AC-SPEC-00-09', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, { [RECORD_PATH]: recordWith([2.5, 2.5], 0) }));
  const run = withEdits(scratch.root, { [RECORD_PATH]: recordWith([2.5, 2.5], 0) }, costReport);
  assert.equal(run.passed, true, describeRun(run));
});

test('counter-example: amounts that sum to exactly USD 5 in cents pass, whatever binary rounding does', { criterion: 'AC-SPEC-00-09' }, () => {
  const run = withEdits(scratch.root, { [RECORD_PATH]: recordWith([0.03, 4.07, 0.9], 0) }, costReport);
  assert.equal(run.passed, true, describeRun(run));
});

test('counter-example: the budget applies only at zero customers', { criterion: 'AC-SPEC-00-09' }, () => {
  const run = withEdits(scratch.root, { [RECORD_PATH]: recordWith([2.5, 2.51], 1) }, costReport);
  assert.equal(run.passed, true, describeRun(run));
});
