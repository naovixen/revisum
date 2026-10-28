// Evidence mode adds no runtime dependency to contracts or engine: the report decoder is written by
// hand in engine, which imports only its own files, Node built-ins and contracts. And no package
// but cli wires engine and runner together, so the code that decodes a suite's outputs never
// starts the container that produces them. A planted file shows each check can fail.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { PACKAGES } from '../support/repository.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];

// Imported module names in TypeScript source: static imports, re-exports and dynamic imports.
const IMPORTED = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const sourceFiles = (folder: string): string[] =>
  existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name))
    : [];

const importsOf = (source: string): string[] => [...source.matchAll(IMPORTED)].map((match) => match[1] ?? '');

// The imports that are neither relative, a Node built-in nor one of `allowedPackages`.
const foreignImports = (source: string, allowedPackages: readonly string[]): string[] =>
  importsOf(source).filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(name));

const declaredDependencies = (manifest: Record<string, unknown>): string[] => DEPENDENCY_FIELDS.filter((field) => {
  const value = manifest[field];
  return value !== undefined && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0);
});

const manifestOf = (packageFolder: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PACKAGES, packageFolder, 'package.json'), 'utf8'));

// ---- contracts and engine ----------------------------------------------------------------------

for (const checked of [{ name: 'contracts', allowed: [] }, { name: 'engine', allowed: ['@revisum/contracts'] }] as const) {
  test(`${checked.name} declares no runtime dependency and imports only its own files, Node built-ins and allowed packages`, { criterion: 'AC-SPEC-35-22' }, () => {
    assert.deepEqual(declaredDependencies(manifestOf(checked.name)), []);
    const files = sourceFiles(join(PACKAGES, checked.name, 'src'));
    assert.ok(files.length > 0);
    const found = files.flatMap((file) => foreignImports(readFileSync(file, 'utf8'), checked.allowed).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });
}

test('the suite report decoder lives in engine, so the checks above cover it', { criterion: 'AC-SPEC-35-22' }, () => {
  const defining = sourceFiles(join(PACKAGES, 'engine', 'src'))
    .filter((file) => /\bexport\s+(?:async\s+)?function\s+parseSuiteReport\b|\bexport\s+const\s+parseSuiteReport\b/.test(readFileSync(file, 'utf8')));
  assert.equal(defining.length, 1, `files defining parseSuiteReport in engine: ${defining.map((file) => relative(PACKAGES, file)).join(', ')}`);
});

// ---- engine and runner are wired only in cli -----------------------------------------------------

const ENGINE = '@revisum/engine';
const RUNNER = '@revisum/runner';

// True when the sources import both engine and runner, or the manifest depends on both.
function wiresEngineAndRunner(sources: readonly string[], manifest: Record<string, unknown>): boolean {
  const imported = new Set(sources.flatMap(importsOf));
  const dependencies = new Set(DEPENDENCY_FIELDS.flatMap((field) => {
    const value = manifest[field];
    return typeof value === 'object' && value !== null ? Object.keys(value) : [];
  }));
  const uses = (name: string): boolean => imported.has(name) || dependencies.has(name);
  return uses(ENGINE) && uses(RUNNER);
}

test('no package but cli imports both engine and runner', { criterion: 'AC-SPEC-35-22' }, () => {
  const packages = readdirSync(PACKAGES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(packages.includes('cli') && packages.includes('runner') && packages.includes('engine'));
  const wiring = packages.filter((name) => name !== 'cli').filter((name) => {
    const sources = sourceFiles(join(PACKAGES, name, 'src')).map((file) => readFileSync(file, 'utf8'));
    return wiresEngineAndRunner(sources, manifestOf(name));
  });
  assert.deepEqual(wiring, []);
});

// Mutants: the check finds the pair however it is written, and only the pair.
test('the wiring check finds a planted package that imports both, and passes one that imports one', { criterion: 'AC-SPEC-35-22' }, () => {
  const both = ["import { parseSuiteReport } from '@revisum/engine';", "import type { WorkloadRunner } from '@revisum/runner';"];
  assert.equal(wiresEngineAndRunner(both, {}), true);
  assert.equal(wiresEngineAndRunner([both[0] ?? ''], { dependencies: { [RUNNER]: '*' } }), true);
  assert.equal(wiresEngineAndRunner(["const runner = await import('@revisum/runner');", "export * from '@revisum/engine';"], {}), true);
  assert.equal(wiresEngineAndRunner([both[0] ?? ''], {}), false);
  assert.equal(wiresEngineAndRunner(["import { failure } from '@revisum/contracts';"], {}), false);
});
