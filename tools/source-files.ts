// Lists the code files a source lint reads: everything under packages/ and tools/, apart from
// build output and installed packages. Paths are relative to the repository root, with forward
// slashes, so lint messages and allow-lists read the same on every platform.
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { tokenize, type Token } from './lint-names.ts';

const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
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
