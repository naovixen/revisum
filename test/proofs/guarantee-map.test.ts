// Every phase-1 guarantee the product publishes maps to the CI test that proves it
// (tools/guarantee-map.ts). The gates step, `node tools/guarantee-map.ts`, fails when a mapped
// test is in no result of the run or did not pass, and writes .test-results/guarantees.md with
// each row's class for that run: the proven class when its test passed, else its weaker class
// (by default "claimed, not proven by CI"). The published table, docs/guarantees.md, must equal
// what a green run generates.
// Three rows have no test until later specs and are marked pending with those specs: a pending
// row shows its weaker class and passes while any of its specs is unticked in START.md, and fails
// like any other row once they are all ticked.
// Each test works in a throw-away copy of the repository whose test folders are replaced by
// stand-in tests, one per mapped test id (`<file>#<full name>`), each made to pass, fail or be
// left out. tools/run-test-folder.ts runs them and writes the results the gates step reads.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { specId } from '../support/criterion-ids.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { withEdits } from './scratch-edits.ts';

const GUARANTEE_ROWS = [
  'ai-output-only-as-plan', 'known-actions-only', 'lifecycle-no-skip', 'declared-log-fields', 'targets-not-substituted',
  'browser-egress-allow-list', 'secrets-absent', 'pii-masked-in-pixels', 'no-pii-in-reports', 'same-inputs-same-result',
  'adapters-substitutable', 'report-runs-no-content', 'actions-tamper-evident', 'spec-to-commit-trace', 'person-approval',
] as const;
type GuaranteeRow = (typeof GUARANTEE_ROWS)[number];

// The rows with no test until later specs, and the specs that will give each one its test.
const PENDING_ROWS: Readonly<Partial<Record<GuaranteeRow, readonly number[]>>> = {
  'no-pii-in-reports': [9, 12],
  'actions-tamper-evident': [14],
  'spec-to-commit-trace': [14],
};
const isPending = (row: GuaranteeRow): boolean => PENDING_ROWS[row] !== undefined;

const PROVEN_ROW: GuaranteeRow = 'adapters-substitutable';
const WEAKER_CLASS = 'claimed, not proven by CI';
const RUN_TABLE = '.test-results/guarantees.md';
// The folders whose tests are replaced by stand-ins in the copy.
const TEST_FOLDERS: readonly string[] = ['test', 'proofs'];
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
let mappedTests: ReadonlyMap<GuaranteeRow, string>;

// The guarantee map exported by the copy's tools/guarantee-map.ts: the one export keyed by every
// row. Rows are read by their `testId`, the field the spec gives them.
async function readMappedTests(root: string): Promise<ReadonlyMap<GuaranteeRow, string>> {
  const module: unknown = await import(pathToFileURL(join(root, 'tools', 'guarantee-map.ts')).href);
  const exports = typeof module === 'object' && module !== null ? Object.values(module) : [];
  const map = exports.find((value): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && GUARANTEE_ROWS.every((row) => row in value));
  assert.ok(map !== undefined, 'tools/guarantee-map.ts exports no map keyed by every guarantee row');
  const tests = new Map<GuaranteeRow, string>();
  for (const row of GUARANTEE_ROWS) {
    const entry = map[row];
    const testId = typeof entry === 'object' && entry !== null ? Object.getOwnPropertyDescriptor(entry, 'testId')?.value : undefined;
    if (isPending(row)) continue;
    assert.ok(typeof testId === 'string' && testId.includes('#'), `row ${row} has no test id of the form <file>#<full name>`);
    tests.set(row, testId);
  }
  return tests;
}

before(async () => {
  scratch = copyRepository();
  mappedTests = await readMappedTests(scratch.root);
});
after(() => { scratch.dispose(); });

type Outcome = 'pass' | 'fail' | 'absent';

// Replaces the copy's test folders with one stand-in test per mapped id, runs them, then runs the
// gates step. `outcomes` overrides the default, which is that every mapped test passes.
function runGates(outcomes: Readonly<Partial<Record<GuaranteeRow, Outcome>>>): { readonly gates: ToolRun; readonly table: string } {
  const byFile = new Map<string, { name: string; outcome: Outcome }[]>();
  for (const [row, testId] of mappedTests) {
    const outcome = outcomes[row] ?? 'pass';
    const separator = testId.indexOf('#');
    const file = testId.slice(0, separator);
    const name = testId.slice(separator + 1);
    const tests = byFile.get(file) ?? [];
    // Two rows may share one test; it fails if either row asks it to, and is left out only if all do.
    const existing = tests.find((entry) => entry.name === name);
    if (existing === undefined) tests.push({ name, outcome });
    else if (outcome === 'fail' || existing.outcome === 'absent') existing.outcome = outcome;
    byFile.set(file, tests);
  }
  const topFolders = [...new Set([...byFile.keys()].map((file) => file.split('/')[0] ?? file))];
  assert.ok(topFolders.every((folder) => TEST_FOLDERS.includes(folder)), `a mapped test lies outside ${TEST_FOLDERS.join(' and ')}: ${topFolders.join(', ')}`);
  for (const folder of TEST_FOLDERS) rmSync(join(scratch.root, folder), { recursive: true, force: true });
  rmSync(join(scratch.root, '.test-results'), { recursive: true, force: true });

  for (const [file, tests] of byFile) {
    const lines = ["import { describe, test } from 'node:test';"];
    for (const { name, outcome } of tests) {
      if (outcome === 'absent') continue;
      const parts = name.split(' > ');
      const testName = parts.pop() ?? name;
      const body = outcome === 'pass' ? '() => {}' : "() => { throw new Error('fails on purpose'); }";
      const opening = parts.map((suite) => `describe(${JSON.stringify(suite)}, () => { `).join('');
      lines.push(`${opening}test(${JSON.stringify(testName)}, ${body});${' });'.repeat(parts.length)}`);
    }
    const path = join(scratch.root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
  }

  runTool(join(scratch.root, 'tools', 'run-test-folder.ts'), topFolders, { cwd: scratch.root, timeout: TIMEOUT });
  const gates = runTool(join(scratch.root, 'tools', 'guarantee-map.ts'), [], { cwd: scratch.root, timeout: TIMEOUT });
  let table = '';
  try { table = readFileSync(join(scratch.root, RUN_TABLE), 'utf8'); } catch { table = ''; }
  return { gates, table };
}

function rowLine(table: string, row: GuaranteeRow): string {
  const line = table.split('\n').find((text) => text.includes(row));
  assert.ok(line !== undefined, `the run's table has no line for ${row}:\n${table}`);
  return line;
}

const tickSpecs = (specs: readonly number[]) => (text: string): string => {
  let ticked = text;
  for (const spec of specs) {
    const unticked = `- [ ] ${specId(spec)} `;
    if (!ticked.includes(unticked)) throw new Error(`START.md has no unticked line for ${specId(spec)}`);
    ticked = ticked.replace(unticked, `- [x] ${specId(spec)} `);
  }
  return ticked;
};

// ---- A green run --------------------------------------------------------------------------------

test('when every mapped test passes, the gates step passes and the run matches the published table', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates, table } = runGates({});
  assert.equal(gates.passed, true, describeRun(gates));
  assert.ok(!rowLine(table, PROVEN_ROW).includes(WEAKER_CLASS), `a passing row shows its weaker class:\n${table}`);
  const published = readFileSync(join(scratch.root, 'docs', 'guarantees.md'), 'utf8');
  for (const row of GUARANTEE_ROWS) assert.ok(published.includes(row), `the published table has no row ${row}`);
});

test('every row that is not pending maps to a test id', { criterion: 'AC-SPEC-00-10' }, () => {
  assert.deepEqual([...mappedTests.keys()].sort(), GUARANTEE_ROWS.filter((row) => !isPending(row)).sort());
});

// ---- A failing or missing mapped test -----------------------------------------------------------

test('when a mapped test fails, the gates step fails and the run shows the row\'s weaker class', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const green = runGates({});
  const { gates, table } = runGates({ [PROVEN_ROW]: 'fail' });
  assert.equal(gates.passed, false, describeRun(gates));
  assert.ok(gates.output.includes(PROVEN_ROW) || gates.output.includes(mappedTests.get(PROVEN_ROW) ?? PROVEN_ROW), describeRun(gates));
  assert.notEqual(rowLine(table, PROVEN_ROW), rowLine(green.table, PROVEN_ROW));
  assert.ok(rowLine(table, PROVEN_ROW).includes(WEAKER_CLASS), `the failing row does not show its weaker class:\n${table}`);
});

test('when a mapped test is in no result, the gates step fails and the run shows the row\'s weaker class', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates, table } = runGates({ [PROVEN_ROW]: 'absent' });
  assert.equal(gates.passed, false, describeRun(gates));
  assert.ok(rowLine(table, PROVEN_ROW).includes(WEAKER_CLASS), `the missing row does not show its weaker class:\n${table}`);
});

test('the gates step fails when the published table differs from what a green run generates', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates } = withEdits(scratch.root, {
    'docs/guarantees.md': (text) => text.replace(WEAKER_CLASS, 'proven by CI'),
  }, () => runGates({}));
  assert.equal(gates.passed, false, describeRun(gates));
  assert.ok(gates.output.includes('guarantees.md'), describeRun(gates));
});

// ---- Pending rows -------------------------------------------------------------------------------

test('a pending row whose specs are unticked passes and shows its weaker class', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates, table } = runGates({});
  assert.equal(gates.passed, true, describeRun(gates));
  for (const row of Object.keys(PENDING_ROWS) as GuaranteeRow[]) {
    assert.ok(rowLine(table, row).includes(WEAKER_CLASS), `pending row ${row} does not show its weaker class:\n${table}`);
  }
});

test('a pending row still passes while one of its two specs is unticked', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates } = withEdits(scratch.root, { 'START.md': tickSpecs([9]) }, () => runGates({}));
  assert.equal(gates.passed, true, describeRun(gates));
});

test('a pending row fails once all its specs are ticked', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates } = withEdits(scratch.root, { 'START.md': tickSpecs([9, 12]) }, () => runGates({}));
  assert.equal(gates.passed, false, describeRun(gates));
  assert.ok(gates.output.includes('no-pii-in-reports'), describeRun(gates));
});

test('ticking the spec two pending rows wait for fails both rows', { criterion: 'AC-SPEC-00-10', timeout: TIMEOUT }, () => {
  const { gates } = withEdits(scratch.root, { 'START.md': tickSpecs([14]) }, () => runGates({}));
  assert.equal(gates.passed, false, describeRun(gates));
  assert.ok(gates.output.includes('actions-tamper-evident') && gates.output.includes('spec-to-commit-trace'), describeRun(gates));
});
