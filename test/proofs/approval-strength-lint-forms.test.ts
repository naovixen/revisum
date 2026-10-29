// More ways to make a gate depend on an approval being verified, each of which the approval strength
// check must report: a switch over the strength, a type alias for VerifiedApproval used as a
// parameter type, and an Approval narrowed to strength 'verified' written out by hand. Each test
// plants one file in a throw-away copy of the repository and runs the repository's lint commands
// over it. Taking any Approval, under an alias or narrowed on another field, still passes.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;
// The prefix the approval strength check puts on each problem it reports.
const CHECK_NAME = 'approval strength check: ';

// The lint fails, and the approval strength check itself names the planted file.
function assertStrengthCheckFailsOn(relativePath: string, source: string): void {
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  const reported = outcome.failureOutput.split('\n').some((line) => line.includes(CHECK_NAME) && line.includes(fileName));
  assert.ok(reported, `the approval strength check did not name ${fileName}:\n${outcome.failureOutput}`);
}

function assertLintPassesWith(relativePath: string, source: string): void {
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, true, `the lint rejected ${relativePath}:\n${outcome.failureOutput}`);
}

// ---- Forms the check must report --------------------------------------------------------------------

test("the lint fails on a merge gate that switches on an approval's strength", { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertStrengthCheckFailsOn('packages/engine/src/plan/planted-switch-gate.ts', [
    "import type { Approval } from '@revisum/contracts';",
    'export function mayMerge(approval: Approval): boolean {',
    '  switch (approval.strength) {',
    "    case 'verified': return true;",
    "    case 'declared': return false;",
    '  }',
    '}',
    '',
  ].join('\n'));
});

test('the lint fails on a level function whose parameter type is an alias for VerifiedApproval', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertStrengthCheckFailsOn('packages/report/src/planted-alias-level.ts', [
    "import type { VerifiedApproval } from '@revisum/contracts';",
    'type CheckedApproval = VerifiedApproval;',
    'export const reachesLevelFour = (approvals: readonly CheckedApproval[]): boolean => approvals.length > 0;',
    '',
  ].join('\n'));
});

test("the lint fails on a gate that takes an Approval narrowed to strength 'verified' by hand", { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertStrengthCheckFailsOn('packages/engine/src/planted-narrowed-gate.ts', [
    "import type { Approval } from '@revisum/contracts';",
    "export const opensMergeGate = (approval: Approval & { readonly strength: 'verified' }): boolean => approval.subject.hash.length > 0;",
    '',
  ].join('\n'));
});

test("the lint fails on a metric whose narrowed approval type is declared apart from the parameter", { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertStrengthCheckFailsOn('packages/report/src/planted-narrowed-metric.ts', [
    "import type { Approval } from '@revisum/contracts';",
    "type CheckedApproval = Approval & { readonly strength: 'verified' };",
    'export const approvedChanges = (approvals: readonly CheckedApproval[]): number => approvals.length;',
    '',
  ].join('\n'));
});

test('the lint still fails on a gate that takes VerifiedApproval directly', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  // The existing control, re-planted with the approval strength check named.
  assertStrengthCheckFailsOn('packages/engine/src/plan/planted-direct-gate.ts', [
    "import type { VerifiedApproval } from '@revisum/contracts';",
    'export const opensMergeGate = (approval: VerifiedApproval): boolean => approval.subject.hash.length > 0;',
    '',
  ].join('\n'));
});

// ---- Counter-examples the check must accept -------------------------------------------------------------

test('the lint accepts a gate whose parameter type is an alias for any Approval', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/report/src/planted-alias-level.ts', [
    "import type { Approval } from '@revisum/contracts';",
    'type AnyApproval = Approval;',
    'export const reachesLevelFour = (approvals: readonly AnyApproval[]): boolean => approvals.length > 0;',
    '',
  ].join('\n'));
});

test('the lint accepts a gate that narrows an Approval on its subject, not its strength', { criterion: 'AC-SPEC-02-20', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/engine/src/planted-narrowed-gate.ts', [
    "import type { Approval, ApprovalSubject } from '@revisum/contracts';",
    "export const opensMergeGate = (approval: Approval & { readonly subject: ApprovalSubject & { readonly kind: 'plan' } }): boolean =>",
    '  approval.subject.hash.length > 0;',
    '',
  ].join('\n'));
});
