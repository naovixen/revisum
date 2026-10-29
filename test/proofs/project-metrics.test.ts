// The project's own metrics, recorded by the gates step at the end of every CI run:
//   - agentAuthoredShare: commits with an Agent trailer over commits since the trailer cut-over;
//   - specLinkedShare: commits with a Spec or Criteria trailer over the same commits;
//   - tracedCriteriaShare: criterion ids in docs/specs/ with at least one passing tagged test in
//     this run, over every criterion id in docs/specs/;
//   - flakyRunRate: 1 when a failing test file passed on its one measuring rerun, else 0.
// The approval behind them is the founder's push under the agent lock-down, so they are recorded
// as declared, never verified. A commit after the cut-over with a malformed trailer fails.
// Each test builds a throw-away Git repository with fixture specs, commits and test files, runs
// the tests with tools/run-test-folder.ts (which writes .test-results/), then runs
// `node tools/project-metrics.ts --cut-over <commit>` there and compares each share with a hand
// count. The cut-over is given because a fixture repository cannot hold the real one.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { criterionId, specId } from '../support/criterion-ids.ts';
import { createGitRepository, type GitRepository } from '../support/git-repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const RESULTS_FOLDER = '.test-results';
const METRICS_FILE = 'project-metrics.json';
const TRACE_INDEX_FILE = 'trace-index.json';
const CO_AUTHOR_CLAUDE = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const AGENT = 'Agent: claude-code/2.1.312';
const TIMEOUT = 240_000;

// Two fixture specs with five criteria between them.
function specText(spec: number, title: string, criterionCount: number): string {
  const criteria = Array.from({ length: criterionCount }, (_unused, index) =>
    `- ${criterionId(spec, index + 1)}: When the visitor does thing ${index + 1}, the app shall respond (oracle: specified).`);
  return [`# ${specId(spec)}: ${title}`, '', '## Acceptance criteria', '', ...criteria, ''].join('\n');
}
const FIXTURE_SPECS = {
  [`docs/specs/${specId(1)}-sign-up.md`]: specText(1, 'Sign-up', 3),
  [`docs/specs/${specId(2)}-checkout.md`]: specText(2, 'Checkout', 2),
};
const FIXTURE_MANIFEST = { 'package.json': '{ "name": "fixture-project", "private": true, "type": "module" }\n' };

const message = (subject: string, ...trailers: readonly string[]): string =>
  trailers.length === 0 ? `${subject}\n` : `${subject}\n\n${trailers.join('\n')}\n`;

// Tagged tests. Criterion 1 of spec 1 has a passing and a failing test; criterion 2 of spec 1 has
// only a failing one; criterion 1 of spec 2 passes inside a suite. So two of five are traced.
const SIGN_UP_TESTS = [
  "import { test } from 'node:test';",
  `test('signs up with a new email', { criterion: '${criterionId(1, 1)}' }, () => {});`,
  `test('refuses a taken email', { criterion: '${criterionId(1, 1)}' }, () => { throw new Error('fails on purpose'); });`,
  `test('sends a welcome email', { criterion: '${criterionId(1, 2)}' }, () => { throw new Error('fails on purpose'); });`,
  "test('loads the page', () => {});",
  '',
].join('\n');
const CHECKOUT_TESTS = [
  "import { describe, test } from 'node:test';",
  "describe('checkout', () => {",
  `  test('pays by card', { criterion: '${criterionId(2, 1)}' }, () => {});`,
  '});',
  '',
].join('\n');
// Fails on its first attempt and passes on the rerun, by leaving a marker file behind.
const FLAKY_TESTS = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  "import { test } from 'node:test';",
  "const marker = new URL('./first-attempt.marker', import.meta.url);",
  `test('passes on the second attempt', { criterion: '${criterionId(1, 3)}' }, () => {`,
  "  if (!existsSync(marker)) { writeFileSync(marker, ''); throw new Error('the first attempt fails'); }",
  '});',
  '',
].join('\n');
const PASSING_TESTS = [
  "import { test } from 'node:test';",
  `test('pays by bank transfer', { criterion: '${criterionId(2, 2)}' }, () => {});`,
  '',
].join('\n');

let repository: GitRepository;
let cutOver: string;

before(() => {
  repository = createGitRepository();
  // Before the cut-over a Claude co-author without an Agent trailer is not malformed: those
  // commits can't be rewritten, so they are only counted.
  repository.commit({ files: { ...FIXTURE_SPECS, ...FIXTURE_MANIFEST }, message: message('Seed the fixture project', CO_AUTHOR_CLAUDE) });
  cutOver = repository.commit({ files: { 'README.md': '# Fixture project\n' }, message: message('Settle the trailer grammar') });
  // Six commits after the cut-over: four carry Agent, three carry Spec or Criteria.
  repository.commit({
    files: { 'src/sign-up.ts': 'export const signUp = 1;\n' },
    message: message('Build sign-up', AGENT, `Spec: ${specId(1)}`, `Criteria: ${criterionId(1, 1)}, ${criterionId(1, 2)}`, CO_AUTHOR_CLAUDE),
  });
  repository.commit({
    files: { 'src/checkout.ts': 'export const checkout = 1;\n' },
    message: message('Build checkout', AGENT, `Criteria: ${criterionId(2, 1)}`, CO_AUTHOR_CLAUDE),
  });
  repository.commit({
    files: { 'checks/sign-up.test.ts': SIGN_UP_TESTS, 'checks/checkout.test.ts': CHECKOUT_TESTS },
    message: message('Add the fixture tests'),
  });
  repository.commit({ files: { 'docs/notes.md': '# Notes\n' }, message: message('Note the sign-up rules', `Spec: ${specId(1)}`) });
  repository.commit({
    files: { 'flaky-checks/flaky.test.ts': FLAKY_TESTS, 'passing-checks/passing.test.ts': PASSING_TESTS },
    message: message('Add the flaky and passing fixture tests', AGENT, CO_AUTHOR_CLAUDE),
  });
  repository.commit({ files: { 'src/log-in.ts': 'export const logIn = 1;\n' }, message: message('Build log-in', AGENT, CO_AUTHOR_CLAUDE) });
});
after(() => { repository.dispose(); });

const inRepository = (root: string, environment: NodeJS.ProcessEnv) => ({ cwd: root, environment, timeout: TIMEOUT });

function runTests(folder: string): ToolRun {
  rmSync(join(repository.root, RESULTS_FOLDER), { recursive: true, force: true });
  rmSync(join(repository.root, folder, 'first-attempt.marker'), { force: true });
  return runTool('run-test-folder.ts', [folder], inRepository(repository.root, repository.environment));
}

function recordMetrics(root: string, environment: NodeJS.ProcessEnv, cutOverCommit: string): ToolRun {
  return runTool('project-metrics.ts', ['--cut-over', cutOverCommit], inRepository(root, environment));
}

function readResult(root: string, file: string): unknown {
  const path = join(root, RESULTS_FOLDER, file);
  assert.ok(existsSync(path), `${RESULTS_FOLDER}/${file} was not written`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Every value stored under `key`, at any depth.
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) => (name === key ? [inner, ...valuesOf(inner, key)] : valuesOf(inner, key)));
}

function onlyValueOf(value: unknown, key: string): unknown {
  const found = [...new Set(valuesOf(value, key).map((item) => JSON.stringify(item)))];
  assert.equal(found.length, 1, `expected one value for "${key}", found ${found.length}: ${found.join(', ')}`);
  return JSON.parse(found[0] ?? 'null');
}

function assertShare(metrics: unknown, key: string, expected: number): void {
  const share = onlyValueOf(metrics, key);
  assert.equal(typeof share, 'number', `"${key}" is not a number: ${JSON.stringify(share)}`);
  assert.ok(Math.abs(Number(share) - expected) < 1e-9, `"${key}" is ${String(share)}, the hand count gives ${expected}`);
}

// ---- Commit metrics and traced criteria, from one run -------------------------------------------

test('a run with failing tests still fails: the measuring rerun is not a retry', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  const run = runTests('checks');
  assert.equal(run.passed, false, describeRun(run));
});

test('the commit shares equal a hand count of the trailers since the cut-over', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'agentAuthoredShare', 4 / 6);
  assertShare(metrics, 'specLinkedShare', 3 / 6);
  assert.equal(onlyValueOf(metrics, 'beforeTrailers'), 2);
});

test('the traced share counts criteria with at least one passing tagged test, over every criterion in the specs', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'tracedCriteriaShare', 2 / 5);
  // Tests that fail on the rerun too are failing, not flaky.
  assertShare(metrics, 'flakyRunRate', 0);
  assert.equal(onlyValueOf(metrics, 'flakyPair'), false);
});

test('the trace index lists each criterion with its test ids and their outcome', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const index = JSON.stringify(readResult(repository.root, TRACE_INDEX_FILE));
  for (const expected of [criterionId(1, 1), criterionId(2, 1), 'signs up with a new email', 'checkout > pays by card', 'sign-up.test.ts']) {
    assert.ok(index.includes(expected), `the trace index does not mention "${expected}": ${index}`);
  }
});

// ---- Flaky runs ---------------------------------------------------------------------------------

test('a test file that fails and then passes on its rerun fails the run and makes the run flaky', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  const testRun = runTests('flaky-checks');
  assert.equal(testRun.passed, false, `the flaky run passed, so a rerun was used as a retry:\n${describeRun(testRun)}`);
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'flakyRunRate', 1);
  assert.equal(onlyValueOf(metrics, 'flakyPair'), true);
});

test('counter-example: a run where every test passes is not flaky', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  const testRun = runTests('passing-checks');
  assert.equal(testRun.passed, true, describeRun(testRun));
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'flakyRunRate', 0);
  assertShare(metrics, 'tracedCriteriaShare', 1 / 5);
});

// ---- Declared approvals -------------------------------------------------------------------------

test('the metrics and their summary record the approval as declared, not verified', { criterion: 'AC-SPEC-00-19', timeout: TIMEOUT }, () => {
  runTests('passing-checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assert.equal(onlyValueOf(metrics, 'approvalStrength'), 'declared');
  assert.ok(!JSON.stringify(metrics).includes('"verified"'), 'the metrics record a verified approval');
  const folder = join(repository.root, RESULTS_FOLDER);
  const summaries = readdirSync(folder)
    .filter((name) => name.endsWith('.md') && name !== 'guarantees.md')
    .map((name) => readFileSync(join(folder, name), 'utf8'));
  assert.ok(summaries.length > 0, `no Markdown summary in ${RESULTS_FOLDER}/`);
  assert.ok(summaries.some((summary) => /declared/i.test(summary) && /not verified/i.test(summary)),
    `no summary says the approval is declared and not verified:\n${summaries.join('\n---\n')}`);
});

// ---- Malformed trailers -------------------------------------------------------------------------

test('a commit after the cut-over with a malformed trailer fails the check, naming the commit', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  const malformedRepository = createGitRepository();
  try {
    malformedRepository.commit({ files: { ...FIXTURE_SPECS, ...FIXTURE_MANIFEST }, message: message('Seed the fixture project') });
    const malformedCutOver = malformedRepository.commit({ files: { 'README.md': '# Fixture\n' }, message: message('Settle the trailer grammar') });
    malformedRepository.commit({ files: { 'src/a.ts': 'export {};\n' }, message: message('Build sign-up', AGENT, `Spec: ${specId(1)}`, CO_AUTHOR_CLAUDE) });
    const malformed = malformedRepository.commit({
      files: { 'src/b.ts': 'export {};\n' },
      message: message('Build checkout', AGENT, `Criteria: ${criterionId(2, 9)}`, CO_AUTHOR_CLAUDE),
    });
    const run = recordMetrics(malformedRepository.root, malformedRepository.environment, malformedCutOver);
    assert.equal(run.passed, false, describeRun(run));
    assert.ok(run.output.includes(malformed.slice(0, 7)), `the failure does not name the malformed commit ${malformed}:\n${describeRun(run)}`);
  } finally {
    malformedRepository.dispose();
  }
});

test('a commit after the cut-over with a Claude co-author and no Agent trailer fails the check', { criterion: 'AC-SPEC-00-07', timeout: TIMEOUT }, () => {
  const malformedRepository = createGitRepository();
  try {
    malformedRepository.commit({ files: { ...FIXTURE_SPECS, ...FIXTURE_MANIFEST }, message: message('Seed the fixture project') });
    const malformedCutOver = malformedRepository.commit({ files: { 'README.md': '# Fixture\n' }, message: message('Settle the trailer grammar') });
    const malformed = malformedRepository.commit({ files: { 'src/a.ts': 'export {};\n' }, message: message('Build sign-up', `Spec: ${specId(1)}`, CO_AUTHOR_CLAUDE) });
    const run = recordMetrics(malformedRepository.root, malformedRepository.environment, malformedCutOver);
    assert.equal(run.passed, false, describeRun(run));
    assert.ok(run.output.includes(malformed.slice(0, 7)), `the failure does not name the malformed commit ${malformed}:\n${describeRun(run)}`);
  } finally {
    malformedRepository.dispose();
  }
});
