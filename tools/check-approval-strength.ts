// No gate, metric or level may depend on an approval being verified: a declared approval (the
// owner's own push or merge under the agent lock-down) passes exactly as a verified one does, and
// strength may only choose the label shown beside a result. This check fails, naming the file,
// when code in packages/ or tools/:
//   - takes a VerifiedApproval parameter (the type written inside a parameter list), or
//   - compares an approval's strength with 'verified' or 'declared' (with ===, !==, == or !=,
//     either way round), which decides a result by strength.
// Choosing a label by looking the strength up in a table passes.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator, listSourceFiles } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

const VERIFIED_APPROVAL = 'VerifiedApproval';
const STRENGTHS = new Set(['verified', 'declared']);
// How many tokens either side of a comparison may make up the compared expression, as in
// `approval.strength` or `this.approval.strength`.
const OPERAND_REACH = 4;

const isComparisonBefore = (tokens: readonly Token[], index: number): boolean =>
  isPunctuator(tokens[index - 1], '=') && (isPunctuator(tokens[index - 2], '=') || isPunctuator(tokens[index - 2], '!'));
const isComparisonAfter = (tokens: readonly Token[], index: number): boolean =>
  (isPunctuator(tokens[index + 1], '=') || isPunctuator(tokens[index + 1], '!')) && isPunctuator(tokens[index + 2], '=');

// The index just past the operator that starts at `start` (==, ===, != or !==), going forwards.
function pastOperatorForwards(tokens: readonly Token[], start: number): number {
  let index = start + 1;
  while (isPunctuator(tokens[index], '=')) index += 1;
  return index;
}

// The index just before the operator that ends at `end`, going backwards.
function pastOperatorBackwards(tokens: readonly Token[], end: number): number {
  let index = end;
  while (isPunctuator(tokens[index], '=')) index -= 1;
  if (isPunctuator(tokens[index], '!')) index -= 1;
  return index;
}

const strengthWithin = (tokens: readonly Token[], from: number, step: 1 | -1): boolean => {
  for (let offset = 0; offset < OPERAND_REACH; offset++) {
    const token = tokens[from + offset * step];
    if (token === undefined) return false;
    if (isIdentifier(token, 'strength')) return true;
    // Stop at anything that cannot be part of a property access.
    if (token.kind !== 'identifier' && !isPunctuator(token, '.') && !isPunctuator(token, '?')) return false;
  }
  return false;
};

// True when the strength literal at `index` is compared with an expression ending in `strength`.
function comparesStrength(tokens: readonly Token[], index: number): boolean {
  if (isComparisonBefore(tokens, index)) return strengthWithin(tokens, pastOperatorBackwards(tokens, index - 1), -1);
  if (isComparisonAfter(tokens, index)) return strengthWithin(tokens, pastOperatorForwards(tokens, index + 1), 1);
  return false;
}

export function checkApprovalStrength(root: string): string[] {
  const problems: string[] = [];
  for (const path of listSourceFiles(root)) {
    const tokens = codeTokens(readFileSync(join(root, path), 'utf8'));
    // Open brackets, innermost last, so a type written inside "( … )" is known to be in a parameter list.
    const open: string[] = [];
    tokens.forEach((token, index) => {
      if (token.kind === 'punctuator') {
        if (token.text === '(' || token.text === '[' || token.text === '{') open.push(token.text);
        else if (token.text === ')' || token.text === ']' || token.text === '}') open.pop();
      }
      if (isIdentifier(token, VERIFIED_APPROVAL) && open.includes('(')) {
        problems.push(`${path}:${token.line} takes a ${VERIFIED_APPROVAL} parameter; take Approval, so a declared approval passes exactly as a verified one`);
      }
      if (token.kind === 'string' && STRENGTHS.has(token.text) && comparesStrength(tokens, index)) {
        problems.push(`${path}:${token.line} decides by comparing an approval's strength with '${token.text}'; strength may only choose a label, so test for an Approval instead`);
      }
    });
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('approval strength check', checkApprovalStrength(process.cwd()));
