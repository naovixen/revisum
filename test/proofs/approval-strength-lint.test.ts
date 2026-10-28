// No gate, metric or level may depend on an approval being verified: verified and declared both
// pass, and strength only selects a label. Each test plants one file in a throw-away copy of the
// repository and runs the repository's lint commands over it:
//   - a function that takes a VerifiedApproval parameter fails the lint;
//   - a check that compares strength with 'verified' to decide a result fails the lint;
//   - choosing a label by strength passes, so the lint fails for the planted reason only.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;

function assertLintFailsOn(relativePath: string, source: string): void {
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

function assertLintPassesWith(relativePath: string, source: string): void {
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, true, `the lint rejected ${relativePath}:\n${outcome.failureOutput}`);
}

test('the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

// ---- Taking VerifiedApproval --------------------------------------------------------------------

test('the lint fails on an engine gate that takes a VerifiedApproval parameter', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/plan/planted-merge-gate.ts', [
    "import type { VerifiedApproval } from '@revisum/contracts';",
    "// A merge gate only a verified approval can open, so the owner's declared approval would be shut out.",
    'export const opensMergeGate = (approval: VerifiedApproval): boolean => approval.subject.hash.length > 0;',
    '',
  ].join('\n'));
});

test('the lint fails on a level function in another package that takes a VerifiedApproval parameter', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-level.ts', [
    "import type { VerifiedApproval } from '@revisum/contracts';",
    'export function reachesLevelFour(approvals: readonly VerifiedApproval[]): boolean {',
    '  return approvals.length > 0;',
    '}',
    '',
  ].join('\n'));
});

// ---- Testing strength to decide a result --------------------------------------------------------

test("the lint fails on a metric that counts only approvals whose strength is 'verified'", { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/planted-metric.ts', [
    "import type { Approval } from '@revisum/contracts';",
    'export const approvedChanges = (approvals: readonly Approval[]): number =>',
    "  approvals.filter((approval) => approval.strength === 'verified').length;",
    '',
  ].join('\n'));
});

test("the lint fails on a reversed inequality that refuses a strength other than 'verified'", { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-gate.ts', [
    "import type { Approval } from '@revisum/contracts';",
    'export function mayMerge(approval: Approval): boolean {',
    "  if ('verified' !== approval.strength) return false;",
    '  return true;',
    '}',
    '',
  ].join('\n'));
});

// ---- Strength may select a label ----------------------------------------------------------------

test('the lint accepts strength used only to choose the label shown beside a result', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/report/src/planted-label.ts', [
    "import type { Approval, ApprovalStrength } from '@revisum/contracts';",
    'const APPROVAL_LABELS: Readonly<Record<ApprovalStrength, string>> = { verified: \'verified\', declared: \'declared, not verified\' };',
    'export const approvalLabel = (approval: Approval): string => APPROVAL_LABELS[approval.strength];',
    '',
  ].join('\n'));
});

test('the lint accepts a gate that takes any Approval, whatever its strength', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/engine/src/plan/planted-merge-gate.ts', [
    "import type { Approval } from '@revisum/contracts';",
    'export const opensMergeGate = (approval: Approval | null): boolean => approval !== null;',
    '',
  ].join('\n'));
});
