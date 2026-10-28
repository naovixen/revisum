// Plan language 1.2 adds no runtime dependency to contracts or engine: dates are computed with
// Node's built-in Intl, so their locale data is fixed by the Node version, not by a package.
// Each package manifest declares no runtime dependency, and every import in their sources is
// relative, a Node built-in or, for engine, contracts. A planted import shows the check can fail.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
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
function foreignImports(source: string, allowedPackages: readonly string[]): string[] {
  return [...source.matchAll(IMPORTED)]
    .map((match) => match[1] ?? '')
    .filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(name));
}

const PACKAGES_CHECKED = [
  { name: 'contracts', allowed: [] },
  { name: 'engine', allowed: ['@revisum/contracts'] },
] as const;

for (const checked of PACKAGES_CHECKED) {
  test(`${checked.name}'s package manifest declares no runtime dependency`, { criterion: 'AC-SPEC-30-20' }, () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, checked.name, 'package.json'), 'utf8'));
    const declared = DEPENDENCY_FIELDS.filter((field) => {
      const value = manifest[field];
      return value !== undefined && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0);
    });
    assert.deepEqual(declared, []);
  });

  test(`every import in ${checked.name}'s sources is relative, a Node built-in or an allowed workspace package`, { criterion: 'AC-SPEC-30-20' }, () => {
    const folder = join(PACKAGES, checked.name, 'src');
    const files = sourceFiles(folder);
    assert.ok(files.length > 0, `no sources under ${folder}`);
    const found = files.flatMap((file) =>
      foreignImports(readFileSync(file, 'utf8'), checked.allowed).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });
}

// Mutant: the same check finds a date library or a bare package, written any of the usual ways.
test('the import check reports a planted date library, re-export or dynamic import', { criterion: 'AC-SPEC-30-20' }, () => {
  const planted = [
    "import { DateTime } from 'luxon';",
    "export { format } from 'date-fns';",
    "const zones = await import('@formatjs/intl-datetimeformat');",
    "import { readFileSync } from 'node:fs';",
    "import type { Plan } from '@revisum/contracts';",
    "import { brand } from '../brand.ts';",
  ].join('\n');
  assert.deepEqual(foreignImports(planted, ['@revisum/contracts']), ['luxon', 'date-fns', '@formatjs/intl-datetimeformat']);
});
