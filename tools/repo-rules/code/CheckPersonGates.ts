// A person is anyone whose actor type is in PERSON_ACTOR_TYPES: a declared person counts exactly
// as a verified one, because nothing may require a second person. This check fails, naming the
// file, when code in packages/ or tools/ compares an actor type with 'person-verified' alone
// (with ===, !==, == or !=, either way round, or a switch case with no 'person-declared' case
// beside it), or writes a list holding 'person-verified' without 'person-declared', since such a
// gate would leave declared approvals out.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from '../naming/LintRepository.ts';
import { codeTokens, isIdentifier, isPunctuator, isString, listSourceFiles } from '../ListSourceFiles.ts';
import { reportProblems } from '../ReadWorkspacePackages.ts';
import { TokenKind } from '../naming/LintRepository.ts';

const VERIFIED_PERSON = 'person-verified';
const DECLARED_PERSON = 'person-declared';
// After these words "[" starts a list, not an index.
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'yield', 'await', 'typeof', 'case', 'throw', 'void', 'in', 'of', 'default', 'new', 'delete', 'else', 'do']);

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

// True when the "[" at `index` opens a list, not an index into what comes before it: a table lookup
// such as labels['person-verified'] decides nothing about who counts.
function opensList(tokens: readonly Token[], index: number): boolean {
  if (!isPunctuator(tokens[index], '[')) {
    return false;
  }
  const previous = tokens[index - 1];
  if (previous === undefined) {
    return true;
  }
  if (previous.kind === TokenKind.Identifier) {
    return KEYWORDS_BEFORE_EXPRESSION.has(previous.text);
  }
  if (previous.kind !== TokenKind.Punctuator) {
    return false;
  }
  // The tokenizer splits "=>" into "=" and ">"; after an arrow an expression starts.
  const isAfterTypeArguments = previous.text === '>' && !isPunctuator(tokens[index - 2], '=');
  return !isAfterTypeArguments && ![')', ']', '.'].includes(previous.text);
}

// True when the list opened at `open` directly holds 'person-verified' but not 'person-declared'.
function leavesOutDeclaredPerson(tokens: readonly Token[], open: number): boolean {
  let depth = 0;
  let hasVerified = false;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index];
    if (isPunctuator(token, '[') || isPunctuator(token, '{') || isPunctuator(token, '(')) {
      depth += 1;
    } else if (isPunctuator(token, ']') || isPunctuator(token, '}') || isPunctuator(token, ')')) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    } else if (depth === 1 && isString(token, DECLARED_PERSON)) {
      return false;
    } else if (depth === 1 && isString(token, VERIFIED_PERSON)) {
      hasVerified = true;
    }
  }
  return hasVerified;
}

export function checkPersonGates(root: string): string[] {
  const problems: string[] = [];
  for (const path of listSourceFiles(root)) {
    const tokens = codeTokens(readFileSync(join(root, path), 'utf8'));
    tokens.forEach((token, index) => {
      if (opensList(tokens, index) && leavesOutDeclaredPerson(tokens, index)) {
        problems.push(`${path}:${token.line} lists '${VERIFIED_PERSON}' without '${DECLARED_PERSON}'; test membership of PERSON_ACTOR_TYPES so a declared person counts too`);
      }
      if (!isString(token, VERIFIED_PERSON)) return;
      if (isEqualityBefore(tokens, index) || isEqualityAfter(tokens, index) || isLoneCase(tokens, index)) {
        problems.push(`${path}:${token.line} compares an actor type with '${VERIFIED_PERSON}' alone; test membership of PERSON_ACTOR_TYPES so a declared person counts too`);
      }
    });
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('person gate check', checkPersonGates(process.cwd()));
