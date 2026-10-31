// Running database commands adds no runtime dependency to contracts, engine or runner, and widens
// who may read a secret's value by one module at most.
//   - Dependencies: none of the three package manifests declares a runtime dependency, and every
//     import in runner's sources is relative, a Node built-in or contracts. A command runs as the
//     team's own program in a workload container, so no database driver is needed.
//   - Secrets: reveal(), the one way to read a secret's value, may be imported only by the modules
//     on the reveal allow-list (tools/check-secret-reveal.ts). The only module that list may gain
//     for database commands is runner's workload-environment module, which writes a declared
//     secret into the container's environment as the container starts.
// The driver half of this criterion is in page-script-driver-dependencies.test.ts. Planted sources
// and lists show each check can fail.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { PACKAGES, REPOSITORY_ROOT } from '../support/repository.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];

// Imported module names in TypeScript source: static imports, re-exports and dynamic imports.
const IMPORTED = /\b(?:from|import)\s*\(?\s*['"]([^'"\s]+)['"]/g;
// Packages a source resolves by name at run time through a require function.
const RESOLVED = /\b\w*[rR]equire\w*(?:\.resolve)?\(\s*['"]([^'"./][^'"]*)['"]/g;

// The reveal allow-list before database commands, and the one module it may gain for them.
const ALLOW_LIST_BEFORE = [
  'packages/driver-cdp/src/browser-session.ts',
  'packages/driver-playwright/src/playwright-driver.ts',
  'packages/engine/src/secrets/secret-values.ts',
  'packages/runner/src/service-caller.ts',
];
const WORKLOAD_ENVIRONMENT_MODULE = 'packages/runner/src/workload-environment.ts';

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));

const packageOf = (name: string): string => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');

// The imports and run-time resolutions of `source` that are neither relative, a Node built-in nor one of `allowedPackages`.
function foreignModules(source: string, allowedPackages: readonly string[]): string[] {
  const named = [...source.matchAll(IMPORTED), ...source.matchAll(RESOLVED)].map((match) => match[1] ?? '');
  return named.filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(packageOf(name)));
}

function declaredDependencies(packageName: string): Readonly<Record<string, unknown>> {
  const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, packageName, 'package.json'), 'utf8'));
  const declared: Record<string, unknown> = {};
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (typeof value === 'object' && value !== null) Object.assign(declared, value);
  }
  return declared;
}

// The modules the reveal allow-list names, read from the tool's source.
function revealAllowList(toolSource: string = readFileSync(join(REPOSITORY_ROOT, 'tools', 'check-secret-reveal.ts'), 'utf8')): string[] {
  const list = /REVEAL_ALLOWED_MODULES[^=]*=\s*\[([^\]]*)\]/.exec(toolSource);
  assert.ok(list?.[1] !== undefined, 'the tool declares REVEAL_ALLOWED_MODULES');
  return [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

// The modules `after` names that `before` did not, other than the one database commands may add.
const unexpectedAdditions = (after: readonly string[]): string[] =>
  after.filter((path) => !ALLOW_LIST_BEFORE.includes(path) && path !== WORKLOAD_ENVIRONMENT_MODULE);

for (const packageName of ['contracts', 'engine', 'runner']) {
  test(`the ${packageName} package manifest declares no runtime dependency`, { criterion: 'AC-SPEC-36-20' }, () => {
    assert.deepEqual(declaredDependencies(packageName), {});
  });
}

test('every module runner\'s sources import or resolve is relative, a Node built-in or contracts', { criterion: 'AC-SPEC-36-20' }, () => {
  const files = sourceFiles(join(PACKAGES, 'runner', 'src'));
  assert.ok(files.length > 0, 'runner has no sources');
  const found = files.flatMap((file) =>
    foreignModules(readFileSync(file, 'utf8'), ['@revisum/contracts']).map((name) => `${relative(PACKAGES, file)}: ${name}`));
  assert.deepEqual(found, []);
});

test('the reveal allow-list gains no module for database commands but runner\'s workload-environment module', { criterion: 'AC-SPEC-36-20' }, () => {
  const list = revealAllowList();
  assert.deepEqual(unexpectedAdditions(list), []);
  // The list never shrinks below what the other features need.
  assert.deepEqual(ALLOW_LIST_BEFORE.filter((path) => !list.includes(path)), []);
});

// Mutants: the same checks find a planted dependency and a planted allow-list entry.
test('mutant: the module check reports a planted database driver import and run-time resolution', { criterion: 'AC-SPEC-36-20' }, () => {
  const planted = [
    "import { Client } from 'pg';",
    "const mysql = await import('mysql2/promise');",
    "const driver = requireFromHere.resolve('better-sqlite3');",
    "import { createSecret } from '@revisum/contracts';",
    "import { spawn } from 'node:child_process';",
    "import { workloadEnvironment } from './workload-environment.ts';",
  ].join('\n');
  assert.deepEqual(foreignModules(planted, ['@revisum/contracts']), ['pg', 'mysql2/promise', 'better-sqlite3']);
});

test('mutant: an allow-list that also names a database-command module in runner or cli is reported', { criterion: 'AC-SPEC-36-20' }, () => {
  const planted = `export const REVEAL_ALLOWED_MODULES: readonly string[] = [
    ${[...ALLOW_LIST_BEFORE, WORKLOAD_ENVIRONMENT_MODULE, 'packages/runner/src/workload-runner.ts', 'packages/cli/src/database-commands.ts']
    .map((path) => `'${path}'`).join(',\n    ')},
  ];`;
  assert.deepEqual(unexpectedAdditions(revealAllowList(planted)), ['packages/runner/src/workload-runner.ts', 'packages/cli/src/database-commands.ts']);
});
