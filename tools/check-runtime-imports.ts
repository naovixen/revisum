// Keeps third-party browser automation libraries out of the default runtime set: every package
// under packages/ except driver-playwright, the optional fallback adapter. A package of the set
// fails when one of its code files imports a banned library at run time (a static or dynamic
// import, a re-export or a require, a sub-path such as playwright-core/lib/server included), or
// imports the fallback adapter itself, or when its package.json declares either as a dependency or
// an optional dependency. Type-only imports and exports, and dev dependencies, never run, so they
// do not count; nor does a library's name written as data.
//   node tools/check-runtime-imports.ts    (reads packages/ under the working folder)
// See docs/specs/SPEC-06-cdp-driver.md.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator, listSourceFiles } from './source-files.ts';
import { readWorkspacePackages, reportProblems } from './workspace-packages.ts';

export const BANNED_LIBRARIES: readonly string[] = [
  'playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'webdriverio', 'selenium-webdriver', 'chrome-remote-interface',
];
// The optional fallback adapter: the one package that may use Playwright, and that no package of
// the default set may load.
export const FALLBACK_PACKAGE_FOLDER = 'driver-playwright';
const FALLBACK_PACKAGE_NAME = '@revisum/driver-playwright';
const DECLARED_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'] as const;

// The package a module specifier names: "@scope/name" or "name", without any sub-path.
export function specifierPackage(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

const forbidden = (packageName: string): boolean => BANNED_LIBRARIES.includes(packageName) || packageName === FALLBACK_PACKAGE_NAME;

export type RuntimeImport = { readonly specifier: string; readonly line: number };

// The module specifiers a file loads when it runs. A statement that starts `import type` or
// `export type` is erased before anything runs, so it is left out.
export function runtimeImports(source: string): RuntimeImport[] {
  const tokens = codeTokens(source);
  const found: RuntimeImport[] = [];
  // Inside an import or export statement that may end in `from '<specifier>'`: whether it is type-only.
  let statementIsTypeOnly: boolean | null = null;
  const stringAt = (index: number): Token | undefined => (tokens[index]?.kind === 'string' ? tokens[index] : undefined);
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const isMemberName = isPunctuator(tokens[index - 1], '.');
    if (!isMemberName && (isIdentifier(token, 'import') || isIdentifier(token, 'require')) && isPunctuator(next, '(')) {
      // A dynamic import or a require of a literal specifier.
      const specifier = stringAt(index + 2);
      if (specifier !== undefined) found.push({ specifier: specifier.text, line: specifier.line });
      continue;
    }
    if (!isMemberName && isIdentifier(token, 'import') && next?.kind === 'string') {
      // An import for its side effects only.
      found.push({ specifier: next.text, line: next.line });
      continue;
    }
    if (!isMemberName && (isIdentifier(token, 'import') || isIdentifier(token, 'export')) && !isPunctuator(next, '.')) {
      statementIsTypeOnly = isIdentifier(next, 'type') && !isPunctuator(tokens[index + 2], ',') && !isIdentifier(tokens[index + 2], 'from');
      continue;
    }
    if (statementIsTypeOnly !== null && isIdentifier(token, 'from') && next?.kind === 'string') {
      if (!statementIsTypeOnly) found.push({ specifier: next.text, line: next.line });
      statementIsTypeOnly = null;
    }
  }
  return found;
}

// The dependencies a manifest declares for run time, by name.
function declaredRuntimeDependencies(manifestPath: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  if (typeof manifest !== 'object' || manifest === null) return [];
  const fields = manifest as Record<string, unknown>;
  return DECLARED_DEPENDENCY_FIELDS.flatMap((field) => {
    const declared = fields[field];
    return typeof declared === 'object' && declared !== null ? Object.keys(declared) : [];
  });
}

export function checkRuntimeImports(root: string): string[] {
  const problems: string[] = [];
  for (const workspacePackage of readWorkspacePackages(root)) {
    const folder = workspacePackage.folder;
    if (folder === FALLBACK_PACKAGE_FOLDER) continue;
    for (const dependency of declaredRuntimeDependencies(join(workspacePackage.path, 'package.json'))) {
      if (forbidden(dependency)) {
        problems.push(`packages/${folder}/package.json declares ${dependency}; ${folder} is in the default runtime set, which may not depend on it`);
      }
    }
    for (const file of listSourceFiles(root, [`packages/${folder}`])) {
      for (const loaded of runtimeImports(readFileSync(join(root, file), 'utf8'))) {
        const library = specifierPackage(loaded.specifier);
        if (!forbidden(library)) continue;
        problems.push(`${file}:${loaded.line} imports ${library} ("${loaded.specifier}"); ${folder} is in the default runtime set, which may not load it`);
      }
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('runtime import check', checkRuntimeImports(process.cwd()));
