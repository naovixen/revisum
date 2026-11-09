// Keeps secret values where they belong. reveal() is the one way to read a secret's value, and only
// the modules in REVEAL_ALLOWED_MODULES may import it. This check fails, naming the file, when any
// other code in packages/ or tools/ imports or re-exports reveal, under its own name or another
// (`import { reveal as show }`), reads it from a namespace import or a dynamic import
// (`contracts.reveal`, `contracts['reveal']`, `(await import('…')).reveal`), or destructures it out
// of one (`const { reveal: show } = contracts`, `const { reveal } = await import('…')`,
// `import('…').then(({ reveal }) => reveal)`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from '../naming/LintRepository.ts';
import { closingParenthesis, codeTokens, isIdentifier, isPunctuator, listSourceFiles } from '../ListSourceFiles.ts';
import { reportProblems } from '../ReadWorkspacePackages.ts';
import { TokenKind } from '../naming/LintRepository.ts';

const REVEAL = 'reveal';
const THEN = 'then';
// Where reveal is defined; contracts' index re-exports it with `export *`, which names nothing.
const DEFINING_MODULE = 'packages/contracts/src/ports/Secret.ts';

// The reveal allow-list: the only modules that may import reveal.
//   - the driver's input module, which types a secret into the page at the moment of input;
//   - the engine's secret-values module, which redacts a secret's echoes and scans for leaks, and
//     so has to know what to look for; it also applies a header scheme to a secret, inside a new
//     opaque Secret;
//   - runner's service caller, which writes a declared call's secret headers and body parts as it
//     sends the request.
// Add a module here only with a reason beside it.
export const REVEAL_ALLOWED_MODULES: readonly string[] = [
  'packages/driver-cdp/src/session/actions/TextToFill.ts',
  'packages/engine/src/secrets/SecretRedaction.ts',
  'packages/runner/src/service-calls/ServiceCaller.ts',
];

// The index just past the "}" matching the "{" at `open`.
function closingBrace(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isPunctuator(tokens[index], '{')) {depth += 1;}
    else if (isPunctuator(tokens[index], '}')) { depth -= 1; if (depth === 0) {return index;} }
  }
  return tokens.length;
}

// The index just past a dynamic import whose keyword is at `importIndex`, and past any brackets that
// close around it, as in `(await import(…))`.
function pastDynamicImport(tokens: readonly Token[], importIndex: number): number {
  let past = closingParenthesis(tokens, importIndex + 1) + 1;
  while (isPunctuator(tokens[past], ')')) {
    past += 1;
  }
  return past;
}

// The property read at `index`, in any of `.name`, `?.name`, `!.name`, `['name']` and `?.['name']`.
function propertyNameAt(tokens: readonly Token[], index: number): string | undefined {
  const isOptionalRead = isPunctuator(tokens[index], '?') && isPunctuator(tokens[index + 1], '.');
  const start = isOptionalRead || isPunctuator(tokens[index], '!') ? index + 1 : index;
  const isDotted = isPunctuator(tokens[start], '.');
  const named = tokens[start + 1];
  if (isDotted && named?.kind === TokenKind.Identifier) {
    return named.text;
  }
  const bracket = isDotted ? start + 1 : start;
  const key = tokens[bracket + 1];
  const isOneKey = isPunctuator(tokens[bracket], '[') && isPunctuator(tokens[bracket + 2], ']');
  return isOneKey && (key?.kind === TokenKind.String || key?.kind === TokenKind.Template) ? key.text : undefined;
}

// True when the tokens from `index` start a dynamic import that gives the module whole: `import(…)`,
// `await import(…)`, `(await import(…))`, and not a property read off it such as `.panel`.
function startsDynamicImport(tokens: readonly Token[], index: number): boolean {
  let start = index;
  while (isPunctuator(tokens[start], '(') || isIdentifier(tokens[start], 'await')) {
    start += 1;
  }
  if (!isIdentifier(tokens[start], 'import') || !isPunctuator(tokens[start + 1], '(')) {
    return false;
  }
  const read = propertyNameAt(tokens, pastDynamicImport(tokens, start));
  return read === undefined || read === THEN;
}

// True when the "=" at `index` is an assignment, not part of "==", "===" or "=>".
const isAssignment = (tokens: readonly Token[], index: number): boolean =>
  isPunctuator(tokens[index], '=') && !isPunctuator(tokens[index + 1], '=') && !isPunctuator(tokens[index + 1], '>')
  && !isPunctuator(tokens[index - 1], '=') && !isPunctuator(tokens[index - 1], '!');

// Lines in the object pattern between `open` and `end` that take the property reveal: a key at the
// pattern's own level (`{ reveal }`, `{ reveal: show }`), not a local name given after ":".
function revealKeysInPattern(tokens: readonly Token[], open: number, end: number): number[] {
  const lines: number[] = [];
  let depth = 0;
  for (let inside = open; inside < end; inside++) {
    const token = tokens[inside];
    if (isPunctuator(token, '{') || isPunctuator(token, '[') || isPunctuator(token, '(')) {depth += 1;}
    else if (isPunctuator(token, '}') || isPunctuator(token, ']') || isPunctuator(token, ')')) {depth -= 1;}
    else if (depth === 1 && isIdentifier(token, REVEAL) && (isPunctuator(tokens[inside - 1], '{') || isPunctuator(tokens[inside - 1], ','))) {
      lines.push(token?.line ?? 0);
    }
  }
  return lines;
}

// The first token of the parameter list of the callback passed to the call opened at `open`.
function callbackParameter(tokens: readonly Token[], open: number): number {
  let start = open + 1;
  if (isIdentifier(tokens[start], 'async')) {
    start += 1;
  }
  if (isIdentifier(tokens[start], 'function')) {
    start += isPunctuator(tokens[start + 1], '(') ? 1 : 2;
  }
  return isPunctuator(tokens[start], '(') ? start + 1 : start;
}

type DynamicImportUse = {
  readonly lines: readonly number[];
  // A name that holds the module as a namespace does: `import(…).then((contracts) => …)`.
  readonly namespace: string | undefined;
};

// What the dynamic import at `importIndex` does with the module straight away: reads reveal off it,
// or hands it to a `then` callback that destructures reveal or names the module.
function dynamicImportUse(tokens: readonly Token[], importIndex: number): DynamicImportUse {
  const past = pastDynamicImport(tokens, importIndex);
  const read = propertyNameAt(tokens, past);
  if (read === REVEAL) {
    return { lines: [tokens[importIndex]?.line ?? 0], namespace: undefined };
  }
  if (read !== THEN || !isPunctuator(tokens[past + 2], '(')) {
    return { lines: [], namespace: undefined };
  }
  const parameter = callbackParameter(tokens, past + 2);
  const first = tokens[parameter];
  if (isPunctuator(first, '{')) {
    return { lines: revealKeysInPattern(tokens, parameter, closingBrace(tokens, parameter)), namespace: undefined };
  }
  return { lines: [], namespace: first?.kind === TokenKind.Identifier ? first.text : undefined };
}

// Lines where `tokens` import or re-export reveal, read it from a namespace or a dynamic import, or
// destructure it out of one.
function revealUses(tokens: readonly Token[]): number[] {
  const lines: number[] = [];
  const namespaces = new Set<string>();
  tokens.forEach((token, index) => {
    // `const name = await import(…)` makes a namespace as `import * as name` does.
    if (token.kind === TokenKind.Identifier && isAssignment(tokens, index + 1) && startsDynamicImport(tokens, index + 2)) {namespaces.add(token.text);}
    if (!isIdentifier(token, 'import') && !isIdentifier(token, 'export')) {return;}
    if (isPunctuator(tokens[index - 1], '.')) {return;}
    if (isIdentifier(token, 'import') && isPunctuator(tokens[index + 1], '(')) {
      const use = dynamicImportUse(tokens, index);
      lines.push(...use.lines);
      if (use.namespace !== undefined) {
        namespaces.add(use.namespace);
      }
      return;
    }
    let next = index + 1;
    if (isIdentifier(tokens[next], 'type')) {next += 1;}
    // `import * as name from …`
    if (isPunctuator(tokens[next], '*') && isIdentifier(tokens[next + 1], 'as') && tokens[next + 2]?.kind === TokenKind.Identifier) {
      namespaces.add(tokens[next + 2]?.text ?? '');
      return;
    }
    // `import name, { … } from …`
    if (tokens[next]?.kind === TokenKind.Identifier && isPunctuator(tokens[next + 1], ',')) {next += 2;}
    if (!isPunctuator(tokens[next], '{')) {return;}
    const end = closingBrace(tokens, next);
    for (let inside = next + 1; inside < end; inside++) {
      // The name being imported or exported, not a local alias given with `as`.
      if (isIdentifier(tokens[inside], REVEAL) && !isIdentifier(tokens[inside - 1], 'as')) {lines.push(tokens[inside]?.line ?? token.line);}
    }
  });
  tokens.forEach((token, index) => {
    if (token.kind === TokenKind.Identifier && namespaces.has(token.text) && propertyNameAt(tokens, index + 1) === REVEAL) {
      lines.push(token.line);
    }
    // `{ … } = namespace` or `{ … } = await import(…)`: the pattern names what it takes.
    if (!isPunctuator(token, '{')) {return;}
    const end = closingBrace(tokens, index);
    if (!isAssignment(tokens, end + 1)) {return;}
    const source = tokens[end + 2];
    const fromNamespace = source?.kind === TokenKind.Identifier && namespaces.has(source.text) && !isPunctuator(tokens[end + 3], '.');
    if (fromNamespace || startsDynamicImport(tokens, end + 2)) {lines.push(...revealKeysInPattern(tokens, index, end));}
  });
  return lines;
}

export function checkSecretReveal(root: string): string[] {
  const problems: string[] = [];
  for (const path of listSourceFiles(root)) {
    if (path === DEFINING_MODULE || REVEAL_ALLOWED_MODULES.includes(path)) {continue;}
    for (const line of revealUses(codeTokens(readFileSync(join(root, path), 'utf8')))) {
      problems.push(`${path}:${line} imports ${REVEAL}, which reads a secret's value; only the modules in REVEAL_ALLOWED_MODULES (tools/repo-rules/code/CheckSecretReveal.ts) may`);
    }
  }
  return problems;
}

if (import.meta.main) {process.exitCode = reportProblems('secret reveal check', checkSecretReveal(process.cwd()));}
