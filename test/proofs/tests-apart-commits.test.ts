// The tests-apart check: a change may touch the test set (test/, proofs/, fixtures/, golden/) or
// the code it judges, never both. On a pull request it reads the changed paths from standard
// input; on a push to main, where commits arrive without a pull request, it checks each commit
// of the pushed range on its own (`--commits <from>..<to>`). The range tests build a throw-away
// Git repository, so they never depend on this repository's own history.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createGitRepository, type GitRepository } from '../support/git-repository.ts';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const TOOL = 'check-tests-apart.ts';

const checkPaths = (paths: readonly string[]): ToolRun =>
  runTool(TOOL, [], { cwd: REPOSITORY_ROOT, input: `${paths.join('\n')}\n` });

// ---- Changed paths of a pull request ------------------------------------------------------------

test('a pull request that changes a test and a package source file fails', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkPaths(['test/unit/engine/plan-limits.test.ts', 'packages/engine/src/plan/plan-parser.ts']);
  assert.equal(run.passed, false, describeRun(run));
  assert.ok(run.output.includes('packages/engine/src/plan/plan-parser.ts'), describeRun(run));
});

test('a pull request that changes a golden file and a doc fails', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkPaths(['golden/plans/signup.json', 'docs/glossary.md']);
  assert.equal(run.passed, false, describeRun(run));
});

test('counter-example: a pull request that changes only the test set passes', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkPaths(['test/proofs/type-check.test.ts', 'fixtures/signup-app/index.html', 'golden/plans/signup.json', 'proofs/extra.ts']);
  assert.equal(run.passed, true, describeRun(run));
});

test('counter-example: a pull request that changes only code and docs passes', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkPaths(['packages/engine/src/plan/plan-parser.ts', 'tools/glob.ts', 'docs/glossary.md']);
  assert.equal(run.passed, true, describeRun(run));
});

// ---- Each commit of a pushed range --------------------------------------------------------------

let repository: GitRepository;
let base: string;
let testsOnly: string;
let codeOnly: string;
let mixed: string;
let afterMixed: string;

before(() => {
  repository = createGitRepository();
  base = repository.commit({ files: { 'README.md': '# Fixture project\n' }, message: 'Start the fixture project' });
  testsOnly = repository.commit({
    files: { 'test/unit/sign-up.test.ts': 'export {};\n', 'fixtures/sign-up/form.html': '<form></form>\n' },
    message: 'Test sign-up',
  });
  codeOnly = repository.commit({
    files: { 'packages/app/src/sign-up.ts': 'export const signUp = (): boolean => true;\n', 'docs/sign-up.md': '# Sign-up\n' },
    message: 'Build sign-up',
  });
  mixed = repository.commit({
    files: { 'test/unit/sign-up.test.ts': 'export const edited = true;\n', 'packages/app/src/sign-up.ts': 'export const signUp = (): boolean => false;\n' },
    message: 'Change sign-up and its test together',
  });
  afterMixed = repository.commit({ files: { 'packages/app/src/log-in.ts': 'export const logIn = (): boolean => true;\n' }, message: 'Build log-in' });
});
after(() => { repository.dispose(); });

const checkRange = (from: string, to: string): ToolRun =>
  runTool(TOOL, ['--commits', `${from}..${to}`], { cwd: repository.root, environment: repository.environment });

test('a pushed range holding one commit that changes a test and code together fails, naming that commit', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkRange(base, afterMixed);
  assert.equal(run.passed, false, describeRun(run));
  assert.ok(run.output.includes(mixed.slice(0, 7)), `the output does not name the mixed commit ${mixed}:\n${describeRun(run)}`);
});

test('a range of only the tests-only commit passes, and so does one of only the code-only commit', { criterion: 'AC-SPEC-00-05' }, () => {
  const testsRun = checkRange(base, testsOnly);
  assert.equal(testsRun.passed, true, describeRun(testsRun));
  const codeRun = checkRange(testsOnly, codeOnly);
  assert.equal(codeRun.passed, true, describeRun(codeRun));
});

test('a range of only the mixed commit fails', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkRange(codeOnly, mixed);
  assert.equal(run.passed, false, describeRun(run));
});

test('counter-example: a tests-only commit followed by a code-only commit passes, though their combined diff mixes', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkRange(base, codeOnly);
  assert.equal(run.passed, true, describeRun(run));
});

test('counter-example: a range after the mixed commit passes', { criterion: 'AC-SPEC-00-05' }, () => {
  const run = checkRange(mixed, afterMixed);
  assert.equal(run.passed, true, describeRun(run));
});
