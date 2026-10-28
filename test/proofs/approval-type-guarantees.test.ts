// Approvals are minted only by the approval verifier, and every gate takes an Approval, so a
// decision with no proof, or one from an MCP session or a CI token, can never open a gate, while
// a declared approval opens it exactly as a verified one does. These are compile-time
// guarantees: the guarantee file must compile, and each line marked as an expected error must be
// one.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { compileFiles } from './scratch-compiler.ts';

const GUARANTEE_FILE = join(REPOSITORY_ROOT, 'test', 'proofs', 'approval-type-guarantees.ts');
const EXPECTED_ERROR_LINE = /^\s*\/\/\s*@ts-expect-error\b/;
const TIMEOUT = 300_000;

// The guarantee file with the expected-error marker above the line holding `marker` removed.
function withoutMarkerBefore(marker: string): string {
  const lines = readFileSync(GUARANTEE_FILE, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(marker));
  assert.ok(index > 0, `the guarantee file has no line with ${marker}`);
  const above = lines.slice(0, index).findLastIndex((line) => EXPECTED_ERROR_LINE.test(line));
  assert.ok(above >= 0, `no expected-error marker above ${marker}`);
  return lines.filter((_, lineIndex) => lineIndex !== above).join('\n');
}

const assertMutantFails = (marker: string): void => {
  const compiled = compileFiles([{ name: 'approval-type-guarantees-mutant.ts', source: withoutMarkerBefore(marker) }]);
  assert.equal(compiled.passed, false, `with the marker above ${marker} removed, the file still compiled`);
  assert.equal(compiled.errors.length, 1, compiled.output);
};

test('the approval guarantee file compiles: declared and verified approvals both pass a gate that takes Approval', { criterion: 'AC-SPEC-02-18', timeout: TIMEOUT }, () => {
  const compiled = compileFiles([GUARANTEE_FILE]);
  assert.equal(compiled.passed, true, compiled.output);
});

test('the actor for a local decision with no proof cannot be passed to a gate', { criterion: 'AC-SPEC-02-11', timeout: TIMEOUT }, () => {
  assertMutantFails('localDecisionAtGate');
});

test('the actor for an MCP decision cannot be passed to a gate', { criterion: 'AC-SPEC-02-17', timeout: TIMEOUT }, () => {
  assertMutantFails('mcpDecisionAtGate');
});

test('an approval written as an object literal cannot be passed to a gate', { criterion: 'AC-SPEC-02-17', timeout: TIMEOUT }, () => {
  assertMutantFails("proofKind: 'agent-lockdown-merge'");
});

test('unverified() refuses any source other than local, MCP or token', { criterion: 'AC-SPEC-02-11', timeout: TIMEOUT }, () => {
  assertMutantFails('personSource');
});

test('every expected-error marker in the guarantee file is checked by a test above', { criterion: 'AC-SPEC-02-17' }, () => {
  const markers = readFileSync(GUARANTEE_FILE, 'utf8').split(/\r?\n/).filter((line) => EXPECTED_ERROR_LINE.test(line)).length;
  assert.equal(markers, 4);
});
