// Advancing the clock and reading the clipboard add no runtime dependency to contracts or engine:
// the engine only converts and bounds amounts and compares text, and the timer tracking lives in
// the determinism script, a trusted constant built only from integers. Each package manifest
// declares no runtime dependency, and every import in their sources is relative, a Node built-in
// or, for engine, contracts. A planted fake-timer or clipboard library shows the check can fail.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { PACKAGES } from '../support/repository.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];

// Imported module names in TypeScript source: static imports, re-exports and dynamic imports.
const IMPORTED = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));

// The imports of `source` that are neither relative, a Node built-in nor one of `allowedPackages`.
const foreignImports = (source: string, allowedPackages: readonly string[]): string[] =>
  [...source.matchAll(IMPORTED)]
    .map((match) => match[1] ?? '')
    .filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(name));

const PACKAGES_CHECKED = [
  { name: 'contracts', allowed: [] },
  { name: 'engine', allowed: ['@revisum/contracts'] },
] as const;

for (const checked of PACKAGES_CHECKED) {
  test(`${checked.name}'s package manifest still declares no runtime dependency`, { criterion: 'AC-SPEC-34-19' }, () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, checked.name, 'package.json'), 'utf8'));
    const declared = DEPENDENCY_FIELDS.filter((field) => {
      const value = manifest[field];
      return value !== undefined && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0);
    });
    assert.deepEqual(declared, []);
  });

  test(`every import in ${checked.name}'s sources is still relative, a Node built-in or an allowed workspace package`, { criterion: 'AC-SPEC-34-19' }, () => {
    const folder = join(PACKAGES, checked.name, 'src');
    const files = sourceFiles(folder);
    assert.ok(files.length > 0, `no sources under ${folder}`);
    const found = files.flatMap((file) =>
      foreignImports(readFileSync(file, 'utf8'), checked.allowed).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });
}

// Mutant: the same check finds a fake-timer or clipboard library, written any of the usual ways.
test('the import check reports a planted fake-timer library, clipboard library or dynamic import', { criterion: 'AC-SPEC-34-19' }, () => {
  const planted = [
    "import FakeTimers from '@sinonjs/fake-timers';",
    "export { read } from 'clipboardy';",
    "const freeze = await import('timekeeper');",
    "import { setTimeout as wait } from 'node:timers/promises';",
    "import type { Session } from '@revisum/contracts';",
    "import { clockAdvanceMilliseconds } from './clock-advance.ts';",
  ].join('\n');
  assert.deepEqual(foreignImports(planted, ['@revisum/contracts']), ['@sinonjs/fake-timers', 'clipboardy', 'timekeeper']);
});
