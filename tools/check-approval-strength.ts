// No gate, metric or level may depend on an approval being verified: a declared approval (the
// owner's own push or merge under the agent lock-down) passes exactly as a verified one does, and
// strength may only choose the label shown beside a result. This check fails, naming the file,
// when code in packages/ or tools/:
//   - takes a parameter whose type is VerifiedApproval, an alias of it, or an approval narrowed to
//     one strength by hand, such as `Approval & { strength: 'verified' }` (the type written inside
//     a parameter list, directly or through a type alias declared anywhere in the code);
//   - compares an approval's strength with 'verified' or 'declared' (with ===, !==, == or !=,
//     either way round), or switches on it, which decides a result by strength.
// Choosing a label by looking the strength up in a table passes. Declaring VerifiedApproval, or
// any narrowed type, passes too: only taking one as a parameter decides by strength.
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

const isOpening = (token: Token | undefined): boolean => isPunctuator(token, '(') || isPunctuator(token, '[') || isPunctuator(token, '{');
const isClosing = (token: Token | undefined): boolean => isPunctuator(token, ')') || isPunctuator(token, ']') || isPunctuator(token, '}');

// The index of the bracket that closes the one opened at `openIndex`, or the last index.
function closingIndex(tokens: readonly Token[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (isOpening(tokens[index])) depth += 1;
    else if (isClosing(tokens[index])) depth -= 1;
    if (depth === 0) return index;
  }
  return tokens.length - 1;
}

// True when the brace at `index` opens a type literal joined to another type by `&` or `|`, as in
// `Approval & { … }`. A value never joins an object literal that way, apart from `a || { … }`.
const opensJoinedTypeLiteral = (tokens: readonly Token[], index: number): boolean =>
  isPunctuator(tokens[index], '{') && (isPunctuator(tokens[index - 1], '&')
    || (isPunctuator(tokens[index - 1], '|') && !isPunctuator(tokens[index - 2], '|')));

// The innermost bracket open at each token, so a property is known to sit in a joined type literal.
function innermostOpenings(tokens: readonly Token[]): (number | undefined)[] {
  const open: number[] = [];
  return tokens.map((token, index) => {
    const innermost = open.at(-1);
    if (isOpening(token)) open.push(index);
    else if (isClosing(token)) open.pop();
    return innermost;
  });
}

// True when the string at `index` is the type of a `strength` property in a joined type literal:
// an approval narrowed to one strength by hand, as in `Approval & { readonly strength: 'verified' }`.
function narrowsStrength(tokens: readonly Token[], index: number, innermost: number | undefined): boolean {
  const token = tokens[index];
  if (token?.kind !== 'string' || !STRENGTHS.has(token.text) || !isPunctuator(tokens[index - 1], ':')) return false;
  const named = isIdentifier(tokens[index - 2], 'strength') || (isPunctuator(tokens[index - 2], '?') && isIdentifier(tokens[index - 3], 'strength'));
  return named && innermost !== undefined && opensJoinedTypeLiteral(tokens, innermost);
}

type TypeAlias = { readonly name: string; readonly narrowed: boolean; readonly mentions: ReadonlySet<string> };

// Every `type Name = …;` in a file, with whether its definition narrows a strength by hand and the
// names it mentions, so an alias of VerifiedApproval, or of a narrowed type, is caught where used.
function typeAliases(tokens: readonly Token[]): TypeAlias[] {
  const innermost = innermostOpenings(tokens);
  const aliases: TypeAlias[] = [];
  tokens.forEach((token, index) => {
    const name = tokens[index + 1];
    if (!isIdentifier(token, 'type') || isPunctuator(tokens[index - 1], '.') || name?.kind !== 'identifier') return;
    let start = index + 2;
    if (isPunctuator(tokens[start], '<')) {
      while (start < tokens.length && !isPunctuator(tokens[start], '=')) start += 1;
    }
    if (!isPunctuator(tokens[start], '=')) return;
    const mentions = new Set<string>();
    let narrowed = false;
    let depth = 0;
    for (let position = start + 1; position < tokens.length; position++) {
      const part = tokens[position];
      if (depth === 0 && isPunctuator(part, ';')) break;
      if (isOpening(part)) depth += 1;
      else if (isClosing(part)) depth -= 1;
      if (depth < 0) break;
      if (part?.kind === 'identifier') mentions.add(part.text);
      if (narrowsStrength(tokens, position, innermost[position])) narrowed = true;
    }
    aliases.push({ name: name.text, narrowed, mentions });
  });
  return aliases;
}

// VerifiedApproval, every alias narrowed to one strength by hand, and every alias that mentions
// one of those, followed through any number of aliases.
function strengthTypeNames(aliases: readonly TypeAlias[]): Set<string> {
  const names = new Set([VERIFIED_APPROVAL, ...aliases.filter((alias) => alias.narrowed).map((alias) => alias.name)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const alias of aliases) {
      if (!names.has(alias.name) && [...alias.mentions].some((mentioned) => names.has(mentioned))) {
        names.add(alias.name);
        grew = true;
      }
    }
  }
  return names;
}

// True when the `switch` at `index` switches on an expression ending in `strength`.
function switchesOnStrength(tokens: readonly Token[], index: number): boolean {
  if (!isIdentifier(tokens[index], 'switch') || !isPunctuator(tokens[index + 1], '(')) return false;
  return isIdentifier(tokens[closingIndex(tokens, index + 1) - 1], 'strength');
}

export function checkApprovalStrength(root: string): string[] {
  const files = listSourceFiles(root).map((path) => ({ path, tokens: codeTokens(readFileSync(join(root, path), 'utf8')) }));
  const strengthTypes = strengthTypeNames(files.flatMap(({ tokens }) => typeAliases(tokens)));
  const problems: string[] = [];
  for (const { path, tokens } of files) {
    const innermost = innermostOpenings(tokens);
    // Open brackets, innermost last, so a type written inside "( … )" is known to be in a parameter list.
    const open: string[] = [];
    tokens.forEach((token, index) => {
      if (token.kind === 'punctuator') {
        if (token.text === '(' || token.text === '[' || token.text === '{') open.push(token.text);
        else if (token.text === ')' || token.text === ']' || token.text === '}') open.pop();
      }
      const inParameters = open.includes('(');
      if (token.kind === 'identifier' && strengthTypes.has(token.text) && inParameters) {
        const what = token.text === VERIFIED_APPROVAL ? VERIFIED_APPROVAL : `${token.text}, a type that requires one approval strength,`;
        problems.push(`${path}:${token.line} takes a ${what} parameter; take Approval, so a declared approval passes exactly as a verified one`);
      }
      if (inParameters && narrowsStrength(tokens, index, innermost[index])) {
        problems.push(`${path}:${token.line} takes an approval narrowed to strength '${token.text}'; take Approval, so a declared approval passes exactly as a verified one`);
      }
      if (token.kind === 'string' && STRENGTHS.has(token.text) && comparesStrength(tokens, index)) {
        problems.push(`${path}:${token.line} decides by comparing an approval's strength with '${token.text}'; strength may only choose a label, so test for an Approval instead`);
      }
      if (switchesOnStrength(tokens, index)) {
        problems.push(`${path}:${token.line} decides by switching on an approval's strength; strength may only choose a label, so test for an Approval instead`);
      }
    });
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('approval strength check', checkApprovalStrength(process.cwd()));
