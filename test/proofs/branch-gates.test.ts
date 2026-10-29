// Nothing on the default branch is gated behind a second person. `node tools/check-branch-gates.ts
// --rules <file> [--protection <file>] [--require-checks]` reads GitHub's JSON for a branch's
// rules and its classic protection, and fails when any of them requires an approving review
// (a count of 1 or more), a code-owner review or last-push approval, or requires a status check
// that .github/workflows/ci.yml does not produce. So a merge by the founder after a green run
// meets every required gate. With --require-checks it also fails unless both `ci` and
// `tests-apart` are required, which is how branch protection makes tests-apart block a merge.
// The fixtures in fixtures/branch-gates/ are the planned beta ruleset and one break each.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FIXTURES, REPOSITORY_ROOT } from '../support/repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const fixture = (name: string): string => join(FIXTURES, 'branch-gates', name);

// GitHub answers with no rules as an empty list; `main` has neither rules nor protection today.
const folder = mkdtempSync(join(tmpdir(), 'revisum-branch-gates-'));
after(() => { rmSync(folder, { recursive: true, force: true }); });
const EMPTY_RULES = join(folder, 'empty-rules.json');
const EMPTY_PROTECTION = join(folder, 'empty-protection.json');
writeFileSync(EMPTY_RULES, '[]\n');
writeFileSync(EMPTY_PROTECTION, '{}\n');

function checkGates(rules: string, options: { readonly protection?: string; readonly requireChecks?: boolean } = {}): ToolRun {
  const words = ['--rules', rules];
  if (options.protection !== undefined) words.push('--protection', options.protection);
  if (options.requireChecks === true) words.push('--require-checks');
  return runTool('check-branch-gates.ts', words, { cwd: REPOSITORY_ROOT });
}

const assertPasses = (run: ToolRun): void => { assert.equal(run.passed, true, describeRun(run)); };
// The check failed, and its output gives the reason: a name it must contain, or a pattern.
const assertFails = (run: ToolRun, reason: string | RegExp): void => {
  assert.equal(run.passed, false, describeRun(run));
  const given = typeof reason === 'string' ? run.output.includes(reason) : reason.test(run.output);
  assert.ok(given, `the failure does not give the reason ${String(reason)}:\n${describeRun(run)}`);
};

// ---- No second person ---------------------------------------------------------------------------

test('the planned beta ruleset passes: it requires only the checks CI produces', { criterion: 'AC-SPEC-00-20' }, () => {
  assertPasses(checkGates(fixture('planned-beta-ruleset.json')));
});

test('no rules and no protection, as on main today, pass', { criterion: 'AC-SPEC-00-20' }, () => {
  assertPasses(checkGates(EMPTY_RULES, { protection: EMPTY_PROTECTION }));
});

test('a ruleset that requires one approving review fails', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(fixture('review-count-one.json')), /approving review/i);
});

test('a ruleset that requires a code-owner review fails', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(fixture('code-owner-review.json')), /code.?owner/i);
});

test('a ruleset that requires approval of the last push fails', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(fixture('last-push-approval.json')), /last.?push/i);
});

test('a ruleset that requires a status check ci.yml does not produce fails, naming the check', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(fixture('unknown-required-check.json')), 'build-and-deploy');
});

test('classic protection that requires only CI\'s checks passes', { criterion: 'AC-SPEC-00-20' }, () => {
  assertPasses(checkGates(EMPTY_RULES, { protection: fixture('protection-status-checks-only.json') }));
});

test('classic protection that requires one approving review fails, even when the ruleset is clean', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(fixture('planned-beta-ruleset.json'), { protection: fixture('protection-review-count-one.json') }), /approving review/i);
});

test('classic protection that requires a code-owner review fails', { criterion: 'AC-SPEC-00-20' }, () => {
  assertFails(checkGates(EMPTY_RULES, { protection: fixture('protection-code-owner-review.json') }), /code.?owner/i);
});

// ---- tests-apart is required --------------------------------------------------------------------

test('with --require-checks, the planned beta ruleset passes: ci and tests-apart are both required', { criterion: 'AC-SPEC-00-05' }, () => {
  assertPasses(checkGates(fixture('planned-beta-ruleset.json'), { requireChecks: true }));
});

test('with --require-checks, a ruleset that does not require tests-apart fails, naming it', { criterion: 'AC-SPEC-00-05' }, () => {
  assertFails(checkGates(fixture('without-tests-apart.json'), { requireChecks: true }), 'tests-apart');
});

test('counter-example: without --require-checks, the same ruleset passes', { criterion: 'AC-SPEC-00-05' }, () => {
  assertPasses(checkGates(fixture('without-tests-apart.json')));
});

test('with --require-checks, no rules at all fail', { criterion: 'AC-SPEC-00-05' }, () => {
  assertFails(checkGates(EMPTY_RULES, { requireChecks: true }), 'tests-apart');
});
