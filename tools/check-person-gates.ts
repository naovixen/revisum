// A person is anyone whose actor type is in PERSON_ACTOR_TYPES: a declared person counts exactly
// as a verified one, because nothing may require a second person. This check fails, naming the
// file, when code in packages/ or tools/ compares an actor type with 'person-verified' alone
// (with ===, !==, == or !=, either way round, or a switch case with no 'person-declared' case
// beside it), since such a gate would leave declared approvals out.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator, isString, listSourceFiles } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

const VERIFIED_PERSON = 'person-verified';
const DECLARED_PERSON = 'person-declared';

// True when the tokens just before (or just after) the value at `index` form ==, ===, != or !==.
const isEqualityBefore = (tokens: readonly Token[], index: number): boolean =>
  isPunctuator(tokens[index - 1], '=') && (isPunctuator(tokens[index - 2], '=') || isPunctuator(tokens[index - 2], '!'));
const isEqualityAfter = (tokens: readonly Token[], index: number): boolean =>
  (isPunctuator(tokens[index + 1], '=') || isPunctuator(tokens[index + 1], '!')) && isPunctuator(tokens[index + 2], '=');

// `case 'person-verified':` is a gate on its own unless a `case 'person-declared':` sits next to it.
function isLoneCase(tokens: readonly Token[], index: number): boolean {
  if (!isIdentifier(tokens[index - 1], 'case')) return false;
  const declaredAfter = isIdentifier(tokens[index + 2], 'case') && isString(tokens[index + 3], DECLARED_PERSON);
  const declaredBefore = isPunctuator(tokens[index - 2], ':') && isString(tokens[index - 3], DECLARED_PERSON);
  return !declaredAfter && !declaredBefore;
}

export function checkPersonGates(root: string): string[] {
  const problems: string[] = [];
  for (const path of listSourceFiles(root)) {
    const tokens = codeTokens(readFileSync(join(root, path), 'utf8'));
    tokens.forEach((token, index) => {
      if (!isString(token, VERIFIED_PERSON)) return;
      if (isEqualityBefore(tokens, index) || isEqualityAfter(tokens, index) || isLoneCase(tokens, index)) {
        problems.push(`${path}:${token.line} compares an actor type with '${VERIFIED_PERSON}' alone; test membership of PERSON_ACTOR_TYPES so a declared person counts too`);
      }
    });
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('person gate check', checkPersonGates(process.cwd()));
