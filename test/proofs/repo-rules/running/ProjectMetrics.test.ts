// The project's own metrics, recorded by the gates step at the end of every CI run:
//   - agentAuthoredShare: commits with an Agent trailer over commits since the trailer cut-over;
//   - specLinkedShare: commits with a Spec or Criteria trailer over the same commits;
//   - criteriaTraced over criteriaInScope: criterion ids named in a Criteria trailer since the
//     cut-over, over every criterion id in docs/specs/;
//   - flakyRunRate: 1 when a failing test file passed on its one measuring rerun, else 0.
// The approval behind them is the founder's push under the agent lock-down, so they are recorded
// as declared, never verified. A commit after the cut-over with a malformed trailer fails.
// Each test builds a throw-away Git repository with fixture specs, commits and test files, runs
// the tests with tools/test-runner/RunTestFolder.ts (which writes .test-results/), then runs
// `node tools/metrics/ProjectMetrics.ts --cut-over <commit>` there and compares each share with a hand
// count. The cut-over is given because a fixture repository cannot hold the real one.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { criterionId, specId } from '../../../support/builders/CriterionId.ts';
import { createGitRepository, type GitRepository } from '../../../support/repository/GitRepository.ts';
import { describeRun, runTool, type ToolRun } from '../../../support/repository/ToolRun.ts';

const RESULTS_FOLDER = '.test-results';
const METRICS_FILE = 'project-metrics.json';
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

// Fixture tests: two of them fail on purpose, and one passes inside a suite.
const SIGN_UP_TESTS = [
  "import { test } from 'node:test';",
  `test('signs up with a new email', () => {});`,
  `test('refuses a taken email', () => { throw new Error('fails on purpose'); });`,
  `test('sends a welcome email', () => { throw new Error('fails on purpose'); });`,
  "test('loads the page', () => {});",
  '',
].join('\n');
const CHECKOUT_TESTS = [
  "import { describe, test } from 'node:test';",
  "describe('checkout', () => {",
  `  test('pays by card', () => {});`,
  '});',
  '',
].join('\n');
// Fails on its first attempt and passes on the rerun, by leaving a marker file behind.
const FLAKY_TESTS = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  "import { test } from 'node:test';",
  "const marker = new URL('./first-attempt.marker', import.meta.url);",
  `test('passes on the second attempt', () => {`,
  "  if (!existsSync(marker)) { writeFileSync(marker, ''); throw new Error('the first attempt fails'); }",
  '});',
  '',
].join('\n');
const PASSING_TESTS = [
  "import { test } from 'node:test';",
  `test('pays by bank transfer', () => {});`,
  '',
].join('\n');

// The test runner refuses a repository without the browser module.
const FIXTURE_BROWSER_MODULE = { 'test/support/browser/Browsers.ts': 'export {};\n' };

let repository: GitRepository;
let cutOver: string;

before(() => {
  repository = createGitRepository();
  // Before the cut-over a Claude co-author without an Agent trailer is not malformed: those
  // commits can't be rewritten, so they are only counted.
  repository.commit({ files: { ...FIXTURE_SPECS, ...FIXTURE_MANIFEST, ...FIXTURE_BROWSER_MODULE }, message: message('Seed the fixture project', CO_AUTHOR_CLAUDE) });
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
  return runTool('test-runner/RunTestFolder.ts', [folder], inRepository(repository.root, repository.environment));
}

function recordMetrics(root: string, environment: NodeJS.ProcessEnv, cutOverCommit: string): ToolRun {
  return runTool('metrics/ProjectMetrics.ts', ['--cut-over', cutOverCommit], inRepository(root, environment));
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

test('a run with failing tests still fails: the measuring rerun is not a retry', { timeout: TIMEOUT }, () => {
  const run = runTests('checks');
  assert.equal(run.passed, false, describeRun(run));
});

test('the commit shares equal a hand count of the trailers since the cut-over', { timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'agentAuthoredShare', 4 / 6);
  assertShare(metrics, 'specLinkedShare', 3 / 6);
  assert.equal(onlyValueOf(metrics, 'beforeTrailers'), 2);
});

test('the traced criteria are those named in a Criteria trailer since the cut-over, out of every criterion in the specs', { timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assert.equal(onlyValueOf(metrics, 'criteriaTraced'), 3);
  assert.equal(onlyValueOf(metrics, 'criteriaInScope'), 5);
  // Tests that fail on the rerun too are failing, not flaky.
  assertShare(metrics, 'flakyRunRate', 0);
  assert.equal(onlyValueOf(metrics, 'flakyPair'), false);
});

test('the metrics hold no share of criteria traced to a passing test, and no trace index is written', { timeout: TIMEOUT }, () => {
  runTests('checks');
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  assert.ok(!JSON.stringify(readResult(repository.root, METRICS_FILE)).includes('tracedCriteriaShare'));
  assert.ok(!existsSync(join(repository.root, RESULTS_FOLDER, 'trace-index.json')));
});

// ---- Flaky runs ---------------------------------------------------------------------------------

test('a test file that fails and then passes on its rerun fails the run and makes the run flaky', { timeout: TIMEOUT }, () => {
  const testRun = runTests('flaky-checks');
  assert.equal(testRun.passed, false, `the flaky run passed, so a rerun was used as a retry:\n${describeRun(testRun)}`);
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'flakyRunRate', 1);
  assert.equal(onlyValueOf(metrics, 'flakyPair'), true);
});

test('counter-example: a run where every test passes is not flaky', { timeout: TIMEOUT }, () => {
  const testRun = runTests('passing-checks');
  assert.equal(testRun.passed, true, describeRun(testRun));
  const run = recordMetrics(repository.root, repository.environment, cutOver);
  assert.equal(run.passed, true, describeRun(run));
  const metrics = readResult(repository.root, METRICS_FILE);
  assertShare(metrics, 'flakyRunRate', 0);
});

// ---- Declared approvals -------------------------------------------------------------------------

test('the metrics and their summary record the approval as declared, not verified', { timeout: TIMEOUT }, () => {
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

test('a commit after the cut-over with a malformed trailer fails the check, naming the commit', { timeout: TIMEOUT }, () => {
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

test('a commit after the cut-over with a Claude co-author and no Agent trailer fails the check', { timeout: TIMEOUT }, () => {
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
