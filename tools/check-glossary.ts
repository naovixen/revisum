// Keeps docs/glossary.md true. It fails when:
//   - a code name in the Domain terms or Metrics table does not resolve. A name resolves when it is
//     an exported declaration in packages/*/src or tools/, or a string literal or property name
//     declared in packages/*/src (step names, union members such as runTimers); a name that looks
//     like a path (it holds "/" or ends in a file extension) resolves when that file exists or a
//     package declares it as a string. Code names of other shapes, such as JSON examples, are
//     skipped, and so is a row whose "Where" says only "planned";
//   - a type or interface the engine's public API exports (packages/engine/src/index.ts, following
//     `export *` into contracts) is not a code name in the glossary;
//   - the Standard names table differs from standardNames in tools/naming-lint-config.ts.
// Sources are read as text: the compiler has no stable API to ask.
// Runs in `npm run lint`. See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenize, type Token } from './lint-names.ts';
import { NAMING_LINT } from './naming-lint-config.ts';
import { reportProblems } from './workspace-packages.ts';

export const GLOSSARY_PATH = 'docs/glossary.md';
const ENGINE_ENTRY = 'packages/engine/src/index.ts';
const CODE_TABLES = ['Domain terms', 'Metrics'];
const STANDARD_NAMES_TABLE = 'Standard names';
const PATH_EXTENSION = /\.(ts|js|mjs|json|md|yml|yaml|html|css|svg|png)$/;
const MODIFIERS = new Set(['declare', 'async', 'default', 'abstract']);
const VALUE_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'enum', 'namespace']);

// ---- The glossary's tables ----------------------------------------------------------------------

export type GlossaryRow = { readonly table: string; readonly cells: readonly string[]; readonly codeNames: readonly string[]; readonly where: string };

// A table row's cells, split at pipes that are not escaped.
const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());

// Every row of every table, with the section heading it sits under.
export function readGlossaryTables(glossary: string): { readonly table: string; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }[] {
  const tables: { table: string; header: string[]; rows: string[][] }[] = [];
  let section = '';
  let current: { table: string; header: string[]; rows: string[][] } | undefined;
  for (const line of glossary.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) section = (heading[1] ?? '').trim();
    if (!line.trim().startsWith('|')) {
      current = undefined;
      continue;
    }
    const cells = cellsOf(line);
    if (current === undefined) {
      current = { table: section, header: cells, rows: [] };
      tables.push(current);
    } else if (!cells.every((cell) => /^:?-+:?$/.test(cell))) {
      current.rows.push(cells);
    }
  }
  return tables;
}

export function glossaryRows(glossary: string): GlossaryRow[] {
  return readGlossaryTables(glossary)
    .filter((table) => CODE_TABLES.includes(table.table))
    .flatMap((table) => {
      const codeColumn = table.header.indexOf('Code name');
      const whereColumn = table.header.indexOf('Where');
      return table.rows.map((cells) => ({
        table: table.table,
        cells,
        codeNames: [...(cells[codeColumn] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''),
        where: whereColumn === -1 ? '' : cells[whereColumn] ?? '',
      }));
    });
}

// A row whose code names are all still to come.
const isPlanned = (row: GlossaryRow): boolean => /\bplanned\b/i.test(row.where) && !/\bexists?\b/i.test(row.where);

// ---- What the code declares ---------------------------------------------------------------------

type Declarations = {
  readonly exported: ReadonlySet<string>;
  readonly strings: ReadonlySet<string>;
  readonly properties: ReadonlySet<string>;
};

function listCodeFiles(root: string, folder: string, recursive: boolean): string[] {
  const path = join(root, folder);
  if (!existsSync(path)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = `${folder}/${entry.name}`;
    if (entry.isDirectory() && recursive && entry.name !== 'node_modules' && entry.name !== 'dist') files.push(...listCodeFiles(root, child, true));
    else if (entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(child);
  }
  return files;
}

const codeTokens = (root: string, file: string): Token[] => tokenize(readFileSync(join(root, file), 'utf8')).filter((token) => token.kind !== 'comment');
const isPunctuator = (token: Token | undefined, text: string): boolean => token?.kind === 'punctuator' && token.text === text;

// The names a file exports by declaration or in an export list.
function exportedNames(tokens: readonly Token[]): string[] {
  const names: string[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'identifier' || token.text !== 'export') return;
    let next = index + 1;
    while (MODIFIERS.has(tokens[next]?.text ?? '')) next += 1;
    const keyword = tokens[next];
    if (isPunctuator(keyword, '*')) {
      if (tokens[next + 1]?.text === 'as' && tokens[next + 2]?.kind === 'identifier') names.push(tokens[next + 2]?.text ?? '');
      return;
    }
    if (keyword?.text === 'type' && isPunctuator(tokens[next + 1], '{')) next += 1;
    if (isPunctuator(tokens[next], '{')) {
      names.push(...exportList(tokens, next).map((item) => item.exported));
      return;
    }
    if (keyword === undefined || keyword.kind !== 'identifier') return;
    let nameIndex = next + 1;
    if (isPunctuator(tokens[nameIndex], '*')) nameIndex += 1;
    const name = tokens[nameIndex];
    if ((VALUE_KEYWORDS.has(keyword.text) || keyword.text === 'type' || keyword.text === 'interface') && name?.kind === 'identifier') names.push(name.text);
  });
  return names;
}

type ExportItem = { readonly local: string; readonly exported: string; readonly typeOnly: boolean };

// The items of an export list starting at the "{" at `open`.
function exportList(tokens: readonly Token[], open: number): ExportItem[] {
  const statementIsType = tokens[open - 1]?.text === 'type';
  const items: ExportItem[] = [];
  let index = open + 1;
  while (index < tokens.length && !isPunctuator(tokens[index], '}')) {
    let typeOnly = statementIsType;
    if (tokens[index]?.text === 'type' && tokens[index + 1]?.kind === 'identifier' && !isPunctuator(tokens[index + 1], ',')) {
      typeOnly = true;
      index += 1;
    }
    const local = tokens[index]?.text ?? '';
    let exported = local;
    if (tokens[index + 1]?.text === 'as') {
      exported = tokens[index + 2]?.text ?? local;
      index += 2;
    }
    items.push({ local, exported, typeOnly });
    index += 1;
    if (isPunctuator(tokens[index], ',')) index += 1;
  }
  return items;
}

function readDeclarations(root: string): Declarations {
  const exported = new Set<string>();
  const strings = new Set<string>();
  const properties = new Set<string>();
  const packageFolders = existsSync(join(root, 'packages'))
    ? readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}/src`)
    : [];
  const packageFiles = packageFolders.flatMap((folder) => listCodeFiles(root, folder, true));
  for (const file of [...packageFiles, ...listCodeFiles(root, 'tools', false)]) {
    const tokens = codeTokens(root, file);
    for (const name of exportedNames(tokens)) exported.add(name);
    if (!file.startsWith('packages/')) continue;
    tokens.forEach((token, index) => {
      if (token.kind === 'string') strings.add(token.text);
      const next = tokens[index + 1];
      const isKey = isPunctuator(next, ':') || (isPunctuator(next, '?') && isPunctuator(tokens[index + 2], ':'));
      // A method of an interface, type or object literal: `decide(…)` at the start of a member.
      const previous = tokens[index - 1];
      const isMethod = isPunctuator(next, '(') && (isPunctuator(previous, '{') || isPunctuator(previous, ';') || isPunctuator(previous, ',') || previous?.text === 'readonly');
      if (token.kind === 'identifier' && (isKey || isMethod)) properties.add(token.text);
    });
  }
  return { exported, strings, properties };
}

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const WORD = /^[\w-]+$/;

// Why a code name does not resolve, or undefined when it does or has a shape that is not checked.
function unresolved(root: string, declarations: Declarations, codeName: string): string | undefined {
  const declaredWord = (word: string): boolean =>
    declarations.exported.has(word) || declarations.strings.has(word) || declarations.properties.has(word);
  if (codeName.includes('/') || (PATH_EXTENSION.test(codeName) && !codeName.startsWith('.'))) {
    if (/[*?]/.test(codeName) || existsSync(join(root, codeName)) || declarations.strings.has(codeName)) return undefined;
    return `${codeName} is no file in this repository and no string a package declares`;
  }
  if (IDENTIFIER_PATH.test(codeName)) {
    const missing = codeName.split('.').find((word) => !declaredWord(word));
    return missing === undefined ? undefined : `${codeName} is no exported declaration, string or property name in packages/*/src or tools/`;
  }
  if (WORD.test(codeName)) return declaredWord(codeName) ? undefined : `${codeName} is no string a package declares`;
  return undefined;
}

// ---- The engine's public API --------------------------------------------------------------------

// The file an import specifier names, from the file that imports it.
function moduleFile(root: string, from: string, specifier: string): string | undefined {
  const workspace = /^@revisum\/([\w-]+)$/.exec(specifier);
  if (workspace !== null) return `packages/${workspace[1] ?? ''}/src/index.ts`;
  if (!specifier.startsWith('.')) return undefined;
  return join(dirname(from), specifier).split('\\').join('/');
}

// Every type and interface a module exports, following re-exports.
function exportedTypes(root: string, file: string, seen = new Map<string, Set<string>>()): Set<string> {
  const known = seen.get(file);
  if (known !== undefined) return known;
  const types = new Set<string>();
  seen.set(file, types);
  if (!existsSync(join(root, file))) return types;
  const tokens = codeTokens(root, file);
  const localTypes = new Set<string>();
  tokens.forEach((token, index) => {
    const name = tokens[index + 1];
    if ((token.text === 'type' || token.text === 'interface') && token.kind === 'identifier' && name?.kind === 'identifier'
      && (isPunctuator(tokens[index + 2], '=') || isPunctuator(tokens[index + 2], '<') || isPunctuator(tokens[index + 2], '{') || tokens[index + 2]?.text === 'extends')) {
      localTypes.add(name.text);
    }
  });
  tokens.forEach((token, index) => {
    if (token.kind !== 'identifier' || token.text !== 'export') return;
    let next = index + 1;
    while (MODIFIERS.has(tokens[next]?.text ?? '')) next += 1;
    const keyword = tokens[next];
    if (isPunctuator(keyword, '*')) {
      // `export * as name` exports a namespace object, not its types by name.
      if (tokens[next + 1]?.text === 'as') return;
      const specifier = tokens[next + 2];
      const target = specifier?.kind === 'string' ? moduleFile(root, file, specifier.text) : undefined;
      if (target !== undefined) for (const type of exportedTypes(root, target, seen)) types.add(type);
      return;
    }
    if ((keyword?.text === 'type' || keyword?.text === 'interface') && tokens[next + 1]?.kind === 'identifier') {
      types.add(tokens[next + 1]?.text ?? '');
      return;
    }
    if (keyword?.text === 'type' && isPunctuator(tokens[next + 1], '{')) next += 1;
    if (!isPunctuator(tokens[next], '{')) return;
    const items = exportList(tokens, next);
    let close = next;
    while (close < tokens.length && !isPunctuator(tokens[close], '}')) close += 1;
    const specifier = tokens[close + 1]?.text === 'from' ? tokens[close + 2] : undefined;
    const target = specifier?.kind === 'string' ? moduleFile(root, file, specifier.text) : undefined;
    const sourceTypes = target === undefined ? localTypes : exportedTypes(root, target, seen);
    for (const item of items) if (item.typeOnly || sourceTypes.has(item.local)) types.add(item.exported);
  });
  return types;
}

// ---- The check ----------------------------------------------------------------------------------

function standardNamesProblems(glossary: string): string[] {
  const table = readGlossaryTables(glossary).find((candidate) => candidate.table === STANDARD_NAMES_TABLE);
  const listed = new Map((table?.rows ?? []).map((cells) => [cells[0] ?? '', cells[1] ?? '']));
  const problems: string[] = [];
  for (const [acronym, fullName] of Object.entries(NAMING_LINT.standardNames)) {
    const given = listed.get(acronym);
    if (given === undefined) problems.push(`the standard name ${acronym} (${fullName}) is missing from the Standard names table`);
    else if (given !== fullName) problems.push(`the standard name ${acronym} is "${given}" in the glossary, but "${fullName}" in tools/naming-lint-config.ts`);
  }
  for (const acronym of listed.keys()) {
    if (!Object.hasOwn(NAMING_LINT.standardNames, acronym)) problems.push(`the Standard names table lists ${acronym}, which tools/naming-lint-config.ts does not`);
  }
  return problems;
}

export function checkGlossary(root: string): string[] {
  const path = join(root, GLOSSARY_PATH);
  if (!existsSync(path)) return [`${GLOSSARY_PATH} is missing`];
  const glossary = readFileSync(path, 'utf8');
  const rows = glossaryRows(glossary);
  const declarations = readDeclarations(root);
  const problems: string[] = [];
  for (const row of rows) {
    if (isPlanned(row)) continue;
    for (const codeName of row.codeNames) {
      const why = unresolved(root, declarations, codeName);
      if (why !== undefined) problems.push(`${GLOSSARY_PATH}, row "${row.cells[0] ?? ''}": ${why}`);
    }
  }
  const listed = new Set(rows.flatMap((row) => row.codeNames));
  const publicTypes = [...exportedTypes(root, ENGINE_ENTRY)].sort();
  for (const type of publicTypes) {
    if (!listed.has(type)) problems.push(`${GLOSSARY_PATH}: ${type}, a type the engine exports, is not a code name in the Domain terms table`);
  }
  problems.push(...standardNamesProblems(glossary).map((problem) => `${GLOSSARY_PATH}: ${problem}`));
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('glossary check', checkGlossary(process.cwd()));
