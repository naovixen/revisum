// Lists the code files a source lint reads: everything under packages/ and tools/, apart from
// build output and installed packages. Paths are relative to the repository root, with forward
// slashes, so lint messages and allow-lists read the same on every platform.
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { tokenize, type Token } from './naming/LintRepository.ts';

export const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist']);
export const LINTED_FOLDERS = ['packages', 'tools'];

function listFolder(root: string, folder: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, folder), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFolder(root, path));
    else if (entry.isFile() && CODE_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

export function listSourceFiles(root: string, folders: readonly string[] = LINTED_FOLDERS): string[] {
  return folders.flatMap((folder) => listFolder(root, folder)).sort();
}

// The tokens of a file that are code, without its comments, so prose never trips a rule.
export const codeTokens = (source: string): Token[] => tokenize(source).filter((token) => token.kind !== 'comment');

export const isPunctuator = (token: Token | undefined, text: string): boolean => token?.kind === 'punctuator' && token.text === text;
export const isIdentifier = (token: Token | undefined, text: string): boolean => token?.kind === 'identifier' && token.text === text;
export const isString = (token: Token | undefined, text: string): boolean => token?.kind === 'string' && token.text === text;

// The index of the ")" matching the "(" at `open`, or the last index past the tokens when it has none.
export function closingParenthesis(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isPunctuator(tokens[index], '(')) {
      depth += 1;
    } else if (isPunctuator(tokens[index], ')')) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return tokens.length;
}

export type ModuleSpecifier = {
  readonly specifier: string;
  readonly line: number;
  // `import type …` or `export type …`, which is erased before anything runs.
  readonly isTypeOnly: boolean;
  // What the statement takes, between its keyword and `from`. Empty for an import for its side
  // effects only; undefined for a dynamic import or a require, which take the module whole.
  readonly clause: readonly Token[] | undefined;
};

// A clause that starts `type` is type-only, unless `type` is the name of a default import.
const isTypeOnlyClause = (clause: readonly Token[]): boolean =>
  isIdentifier(clause[0], 'type') && clause.length > 1 && !isPunctuator(clause[1], ',');

// Every module a file names in an import, an export or a require. A template literal counts as far
// as its first substitution, which is what can still name a package: `puppeteer/${path}` does, and
// `./${name}.ts` stays local. A specifier with nothing fixed to read, such as import(name), is left out.
export function moduleSpecifiers(source: string): ModuleSpecifier[] {
  const tokens = codeTokens(source);
  const found: ModuleSpecifier[] = [];
  // The keyword of the import or export statement whose `from` is still to come.
  let statementStart: number | undefined;
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const isMemberName = isPunctuator(tokens[index - 1], '.');
    const isStatementWord = !isMemberName && (isIdentifier(token, 'import') || isIdentifier(token, 'export'));
    if (!isMemberName && (isIdentifier(token, 'import') || isIdentifier(token, 'require')) && isPunctuator(next, '(')) {
      const argument = tokens[index + 2];
      if ((argument?.kind === 'string' || argument?.kind === 'template') && argument.text !== '') {
        found.push({ specifier: argument.text, line: argument.line, isTypeOnly: false, clause: undefined });
      }
    } else if (isStatementWord && next?.kind === 'string') {
      found.push({ specifier: next.text, line: next.line, isTypeOnly: false, clause: [] });
    } else if (isStatementWord && !isPunctuator(next, '.')) {
      statementStart = index;
    } else if (statementStart !== undefined && isIdentifier(token, 'from') && next?.kind === 'string') {
      const clause = tokens.slice(statementStart + 1, index);
      found.push({ specifier: next.text, line: next.line, isTypeOnly: isTypeOnlyClause(clause), clause });
      statementStart = undefined;
    }
  }
  return found;
}
