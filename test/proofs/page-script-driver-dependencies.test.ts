// Running CSS and XPath locators, DOM checks and page scripts adds no runtime dependency to either
// driver, and no driver module passes a secret to a page script.
//   - Dependencies: the own CDP driver's manifest declares none, and the Playwright fallback's
//     declares exactly the two it had before (Playwright and axe-core, at the same versions). Every
//     import in their sources is relative, a Node built-in, contracts or, for the fallback, one of
//     those two; so is every package a source resolves by name at run time.
//   - Secrets: reveal(), the one way to read a secret's value, may be imported only by each
//     driver's input module, and the reveal allow-list (tools/check-secret-reveal.ts) still names
//     only those two driver modules. In each, reveal is called at one place: the fill that types a
//     secret into the page. A page-script path that revealed a secret would be a second call.
// The runtime half, a script called with only its declared arguments after a secret was typed, is
// in test/contract/page-script-arguments.test.ts. Planted sources show each check can fail.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { PACKAGES, REPOSITORY_ROOT } from '../support/repository.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];

// Imported module names in TypeScript source: static imports, re-exports and dynamic imports. A
// module name holds no white space, so text such as "upload from' })" in a string is no import.
const IMPORTED = /\b(?:from|import)\s*\(?\s*['"]([^'"\s]+)['"]/g;
// Packages a source resolves by name at run time through a require function, such as
// requireFromHere.resolve('axe-core/axe.min.js').
const RESOLVED = /\b\w*[rR]equire\w*\.resolve\(\s*['"]([^'"./][^'"]*)['"]/g;
// A call of reveal, under its own name.
const REVEAL_CALL = /\breveal\s*\(/g;

const DRIVERS = [
  { name: 'driver-cdp', dependencies: {}, packages: ['@revisum/contracts'], inputModule: 'packages/driver-cdp/src/browser-session.ts' },
  {
    name: 'driver-playwright', dependencies: { 'axe-core': '4.14.0', 'playwright-core': '1.64.1' },
    packages: ['@revisum/contracts', 'axe-core', 'playwright-core'], inputModule: 'packages/driver-playwright/src/playwright-driver.ts',
  },
] as const;

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));

// The package a module name belongs to: "@scope/name" or "name", without a path inside it.
const packageOf = (name: string): string => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');

// The imports and run-time resolutions of `source` that are neither relative, a Node built-in nor one of `allowedPackages`.
function foreignModules(source: string, allowedPackages: readonly string[]): string[] {
  const named = [...source.matchAll(IMPORTED), ...source.matchAll(RESOLVED)].map((match) => match[1] ?? '');
  return named.filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(packageOf(name)));
}

// The lines of `source` that call reveal.
const revealCallLines = (source: string): string[] =>
  source.split('\n').filter((line) => !line.trimStart().startsWith('//') && [...line.matchAll(REVEAL_CALL)].length > 0);

// The modules the reveal allow-list names, read from the tool's source.
function revealAllowList(): string[] {
  const tool = readFileSync(join(REPOSITORY_ROOT, 'tools', 'check-secret-reveal.ts'), 'utf8');
  const list = /REVEAL_ALLOWED_MODULES[^=]*=\s*\[([^\]]*)\]/.exec(tool);
  assert.ok(list?.[1] !== undefined, 'the tool declares REVEAL_ALLOWED_MODULES');
  return [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

for (const driver of DRIVERS) {
  test(`${driver.name}'s package manifest declares no runtime dependency beyond the ones it had`, { criterion: 'AC-SPEC-36-20' }, () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, driver.name, 'package.json'), 'utf8'));
    const declared: Record<string, unknown> = {};
    for (const field of DEPENDENCY_FIELDS) {
      const value = manifest[field];
      if (typeof value === 'object' && value !== null) Object.assign(declared, value);
    }
    assert.deepEqual(declared, driver.dependencies);
  });

  test(`every module ${driver.name}'s sources import or resolve is relative, a Node built-in or an allowed package`, { criterion: 'AC-SPEC-36-20' }, () => {
    const folder = join(PACKAGES, driver.name, 'src');
    const files = sourceFiles(folder);
    assert.ok(files.length > 0, `no sources under ${folder}`);
    const found = files.flatMap((file) =>
      foreignModules(readFileSync(file, 'utf8'), driver.packages).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });

  test(`${driver.name} calls reveal at one place only, the fill that types a secret, in its input module`, { criterion: 'AC-SPEC-36-20' }, () => {
    const calls = sourceFiles(join(PACKAGES, driver.name, 'src')).flatMap((file) =>
      revealCallLines(readFileSync(file, 'utf8')).map((line) => ({ file: relative(REPOSITORY_ROOT, file).split('\\').join('/'), line: line.trim() })));
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0]?.file, driver.inputModule);
    assert.match(calls[0]?.line ?? '', /case 'fill'/, 'the one call is in the fill');
  });
}

test('the reveal allow-list names no driver module but the two input modules', { criterion: 'AC-SPEC-36-20' }, () => {
  const driverModules = revealAllowList().filter((path) => path.startsWith('packages/driver-'));
  assert.deepEqual(driverModules.sort(), DRIVERS.map((driver) => driver.inputModule).sort());
});

// Mutants: the same checks find a planted dependency and a planted second reveal.
test('mutant: the module check reports a planted import, dynamic import and run-time resolution', { criterion: 'AC-SPEC-36-20' }, () => {
  const planted = [
    "import { parse } from 'css-what';",
    "const xpath = await import('xpath');",
    "const serialise = require.resolve('safe-stable-stringify/index.js');",
    "const settled = Promise.resolve('not a package');",
    "import type { Secret } from '@revisum/contracts';",
    "import { chromium } from 'playwright-core';",
    "import { readFileSync } from 'node:fs';",
    "import { pageScript } from './page-script.ts';",
  ].join('\n');
  assert.deepEqual(foreignModules(planted, ['@revisum/contracts', 'playwright-core']), ['css-what', 'xpath', 'safe-stable-stringify/index.js']);
});

test('mutant: the reveal check counts a second call in a page-script path, and ignores comments', { criterion: 'AC-SPEC-36-20' }, () => {
  const planted = [
    "      case 'fill': await operations.fill(element, reveal(typedSecret)); break;",
    '      // reveal(secret) is never called here.',
    '      const result = await page.evaluate(source, { ...scriptArguments, token: reveal(secret) });',
  ].join('\n');
  assert.equal(revealCallLines(planted).length, 2);
});
