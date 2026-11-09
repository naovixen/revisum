// Keeps third-party browser automation libraries out of the runtime set: every package under
// packages/. A package fails when one of its code files imports a banned library at run time (a
// static or dynamic import, a re-export or a require, in quotes or a template literal, a sub-path
// such as playwright-core/lib/server included), or when its package.json declares one as a
// dependency or an optional dependency.
// Type-only imports and exports, and dev dependencies, never run, so they do not count; nor does a
// library's name written as data. The repository's own dev dependency on playwright-core, for the
// evidence workload's test suite, is in the root package.json, which is not a package here.
//   node tools/repo-rules/code/CheckRuntimeImports.ts    (reads packages/ under the working folder)
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { listSourceFiles, moduleSpecifiers } from '../ListSourceFiles.ts';
import { readWorkspacePackages, reportProblems } from '../ReadWorkspacePackages.ts';

export const BANNED_LIBRARIES: readonly string[] = [
  'playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'webdriverio', 'selenium-webdriver', 'chrome-remote-interface',
];
const DECLARED_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'] as const;

// The package a module specifier names: "@scope/name" or "name", without any sub-path.
export function specifierPackage(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

const forbidden = (packageName: string): boolean => BANNED_LIBRARIES.includes(packageName);

export type RuntimeImport = { readonly specifier: string; readonly line: number };

// The module specifiers a file loads when it runs. A statement that starts `import type` or
// `export type` is erased before anything runs, so it is left out.
export const runtimeImports = (source: string): RuntimeImport[] =>
  moduleSpecifiers(source)
    .filter((loaded) => !loaded.isTypeOnly)
    .map(({ specifier, line }) => ({ specifier, line }));

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
    for (const dependency of declaredRuntimeDependencies(join(workspacePackage.path, 'package.json'))) {
      if (forbidden(dependency)) {
        problems.push(`packages/${folder}/package.json declares ${dependency}; ${folder} is in the runtime set, which may not depend on it`);
      }
    }
    for (const file of listSourceFiles(root, [`packages/${folder}`])) {
      for (const loaded of runtimeImports(readFileSync(join(root, file), 'utf8'))) {
        const library = specifierPackage(loaded.specifier);
        if (!forbidden(library)) continue;
        problems.push(`${file}:${loaded.line} imports ${library} ("${loaded.specifier}"); ${folder} is in the runtime set, which may not load it`);
      }
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('runtime import check', checkRuntimeImports(process.cwd()));
