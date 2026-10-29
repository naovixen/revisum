// Keeps secret values where they belong. reveal() is the one way to read a secret's value, and only
// the modules in REVEAL_ALLOWED_MODULES may import it. This check fails, naming the file, when any
// other code in packages/ or tools/ imports or re-exports reveal, under its own name or another
// (`import { reveal as show }`), reads it from a namespace import (`contracts.reveal`), or
// destructures it out of a namespace import or a dynamic import
// (`const { reveal: show } = contracts`, `const { reveal } = await import('…')`).
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator, listSourceFiles } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

const REVEAL = 'reveal';
// Where reveal is defined; contracts' index re-exports it with `export *`, which names nothing.
const DEFINING_MODULE = 'packages/contracts/src/secret.ts';

// The reveal allow-list: the only modules that may import reveal.
//   - the drivers' input modules, which type a secret into the page at the moment of input;
//   - the engine's secret-values module, which redacts a secret's echoes and scans for leaks, and
//     so has to know what to look for; it also applies a header scheme to a secret, inside a new
//     opaque Secret;
//   - runner's service caller, which writes a declared call's secret headers and body parts as it
//     sends the request (docs/specs/SPEC-32-declared-service-calls.md).
// Add a module here only with a reason beside it.
export const REVEAL_ALLOWED_MODULES: readonly string[] = [
  'packages/driver-cdp/src/browser-session.ts',
  'packages/driver-playwright/src/playwright-driver.ts',
  'packages/engine/src/secrets/secret-values.ts',
  'packages/runner/src/service-caller.ts',
];

// The index just past the "}" matching the "{" at `open`.
function closingBrace(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isPunctuator(tokens[index], '{')) depth += 1;
    else if (isPunctuator(tokens[index], '}')) { depth -= 1; if (depth === 0) return index; }
  }
  return tokens.length;
}

// True when the tokens from `index` start a dynamic import, `import(…)`, with or without `await`.
function startsDynamicImport(tokens: readonly Token[], index: number): boolean {
  const start = isIdentifier(tokens[index], 'await') ? index + 1 : index;
  return isIdentifier(tokens[start], 'import') && isPunctuator(tokens[start + 1], '(');
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
    if (isPunctuator(token, '{') || isPunctuator(token, '[') || isPunctuator(token, '(')) depth += 1;
    else if (isPunctuator(token, '}') || isPunctuator(token, ']') || isPunctuator(token, ')')) depth -= 1;
    else if (depth === 1 && isIdentifier(token, REVEAL) && (isPunctuator(tokens[inside - 1], '{') || isPunctuator(tokens[inside - 1], ','))) {
      lines.push(token?.line ?? 0);
    }
  }
  return lines;
}

// Lines where `tokens` import or re-export reveal, read it from a namespace import, or destructure
// it out of a namespace import or a dynamic import.
function revealUses(tokens: readonly Token[]): number[] {
  const lines: number[] = [];
  const namespaces = new Set<string>();
  tokens.forEach((token, index) => {
    // `const name = await import(…)` makes a namespace as `import * as name` does.
    if (token.kind === 'identifier' && isAssignment(tokens, index + 1) && startsDynamicImport(tokens, index + 2)) namespaces.add(token.text);
    if (!isIdentifier(token, 'import') && !isIdentifier(token, 'export')) return;
    if (isPunctuator(tokens[index - 1], '.')) return;
    let next = index + 1;
    if (isIdentifier(tokens[next], 'type')) next += 1;
    // `import * as name from …`
    if (isPunctuator(tokens[next], '*') && isIdentifier(tokens[next + 1], 'as') && tokens[next + 2]?.kind === 'identifier') {
      namespaces.add(tokens[next + 2]?.text ?? '');
      return;
    }
    // `import name, { … } from …`
    if (tokens[next]?.kind === 'identifier' && isPunctuator(tokens[next + 1], ',')) next += 2;
    if (!isPunctuator(tokens[next], '{')) return;
    const end = closingBrace(tokens, next);
    for (let inside = next + 1; inside < end; inside++) {
      // The name being imported or exported, not a local alias given with `as`.
      if (isIdentifier(tokens[inside], REVEAL) && !isIdentifier(tokens[inside - 1], 'as')) lines.push(tokens[inside]?.line ?? token.line);
    }
  });
  tokens.forEach((token, index) => {
    if (isIdentifier(token, REVEAL) && isPunctuator(tokens[index - 1], '.') && namespaces.has(tokens[index - 2]?.text ?? '')) lines.push(token.line);
    // `{ … } = namespace` or `{ … } = await import(…)`: the pattern names what it takes.
    if (!isPunctuator(token, '{')) return;
    const end = closingBrace(tokens, index);
    if (!isAssignment(tokens, end + 1)) return;
    const source = tokens[end + 2];
    const fromNamespace = source?.kind === 'identifier' && namespaces.has(source.text) && !isPunctuator(tokens[end + 3], '.');
    if (fromNamespace || startsDynamicImport(tokens, end + 2)) lines.push(...revealKeysInPattern(tokens, index, end));
  });
  return lines;
}

export function checkSecretReveal(root: string): string[] {
  const problems: string[] = [];
  for (const path of listSourceFiles(root)) {
    if (path === DEFINING_MODULE || REVEAL_ALLOWED_MODULES.includes(path)) continue;
    for (const line of revealUses(codeTokens(readFileSync(join(root, path), 'utf8')))) {
      problems.push(`${path}:${line} imports ${REVEAL}, which reads a secret's value; only the modules in REVEAL_ALLOWED_MODULES (tools/check-secret-reveal.ts) may`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('secret reveal check', checkSecretReveal(process.cwd()));
