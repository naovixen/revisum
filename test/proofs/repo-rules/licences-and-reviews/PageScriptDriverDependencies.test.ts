// Running css and XPath locators, DOM checks and page scripts adds no runtime dependency to either
// driver, and no driver module passes a secret to a page script.
//   - Dependencies: the own CDP driver's manifest declares none. Every import in its sources is
//     relative, a Node built-in or contracts; so is every package a source resolves by name at run
//     time.
//   - Secrets: reveal(), the one way to read a secret's value, may be imported only by the
//     driver's input module, and the reveal allow-list (tools/repo-rules/code/CheckSecretReveal.ts) still names
//     only that driver module. In it, reveal is called at one place: the fill that types a
//     secret into the page. A page-script path that revealed a secret would be a second call.
// The runtime half, a script called with only its declared arguments after a secret was typed, is
// in test/browser/page-scripts/PageScriptArguments.test.ts. Planted sources show each check can fail.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSecret, FillValueKind, type FillValue } from '@revisum/contracts';
import { PACKAGES, REPOSITORY_ROOT } from '../../../support/repository/RepositoryRoot.ts';
import { parsedSecretName, SECRET_NAME } from '../../../support/session-contract/SessionUnderTest.ts';

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
  { name: 'driver-cdp', dependencies: {}, packages: ['@revisum/contracts'], inputModule: 'packages/driver-cdp/src/session/actions/TextToFill.ts', fillModule: 'packages/driver-cdp/src/session/actions/ActOnDocument.ts' },
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
  const tool = readFileSync(join(REPOSITORY_ROOT, 'tools', 'repo-rules', 'code', 'CheckSecretReveal.ts'), 'utf8');
  const list = /REVEAL_ALLOWED_MODULES[^=]*=\s*\[([^\]]*)\]/.exec(tool);
  assert.ok(list?.[1] !== undefined, 'the tool declares REVEAL_ALLOWED_MODULES');
  return [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

for (const driver of DRIVERS) {
  test(`${driver.name}'s package manifest declares no runtime dependency beyond the ones it had`, () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, driver.name, 'package.json'), 'utf8')) as Record<string, unknown>;
    const declared: Record<string, unknown> = {};
    for (const field of DEPENDENCY_FIELDS) {
      const value = manifest[field];
      if (typeof value === 'object' && value !== null) {Object.assign(declared, value);}
    }
    assert.deepEqual(declared, driver.dependencies);
  });

  test(`every module ${driver.name}'s sources import or resolve is relative, a Node built-in or an allowed package`, () => {
    const folder = join(PACKAGES, driver.name, 'src');
    const files = sourceFiles(folder);
    assert.ok(files.length > 0, `no sources under ${folder}`);
    const found = files.flatMap((file) =>
      foreignModules(readFileSync(file, 'utf8'), driver.packages).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });

  test(`${driver.name} calls reveal at one place only, the fill that types a secret, in its input module`, () => {
    const calls = sourceFiles(join(PACKAGES, driver.name, 'src')).flatMap((file) =>
      revealCallLines(readFileSync(file, 'utf8')).map((line) => ({ file: relative(REPOSITORY_ROOT, file).split('\\').join('/'), line: line.trim() })));
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0]?.file, driver.inputModule);
    // The one call reveals the secret the fill carries, in the text the fill types and nowhere else.
    assert.match(calls[0].line, /\breveal\(value\.secret\)/, 'the one call reveals the secret its fill carries');
    const fillModule = readFileSync(join(REPOSITORY_ROOT, driver.fillModule), 'utf8');
    // The fill hands the input module the value and the input itself, and is handed nothing back to send.
    assert.match(fillModule, /\btypeFill\(\s*input,\s*element,\s*action\.value,\s*hasStepEnded\b/, 'the fill goes through typeFill');
    assert.doesNotMatch(fillModule, /\binput\.fill\(/, 'the fill module sends no text of its own');
    assert.doesNotMatch(readFileSync(join(REPOSITORY_ROOT, driver.inputModule), 'utf8'), /\btextToFill\b/, 'no function gives the text back');
  });

  describe(`Using ${driver.name}'s input module`, () => {
    const secretValue = 'test-only-input-module-secret';
    const secret = createSecret(parsedSecretName(SECRET_NAME), secretValue);
    const secretFill: FillValue = { kind: FillValueKind.Secret, secret };
    // Only the module under test reads it, and lines hold no secret, so plain strings do.
    const linesFill: unknown = { kind: FillValueKind.Lines, lines: ['one', 'two'] };
    const element = 'the-field';
    const hasStepEnded = (): boolean => false;
    const exportsOfTheModule = async (): Promise<ReadonlyMap<string, unknown>> => {
      const loaded: unknown = await import(pathToFileURL(join(REPOSITORY_ROOT, driver.inputModule)).href);
      assert.ok(typeof loaded === 'object' && loaded !== null, 'the module loads');
      return new Map(Object.entries(loaded));
    };

    // Asked of any function the module exports: whatever it takes, what it gives back never holds the text.
    const callWithAFill = async (exported: unknown): Promise<unknown> => {
      if (typeof exported !== 'function') {
        return undefined;
      }
      try {
        const given = { value: secretFill, ...secretFill };
        const returned: unknown = await Promise.resolve(Reflect.apply(exported, undefined, [given, given]));
        return returned;
      } catch {
        return undefined;
      }
    };

    describe('given the functions it exports', () => {
      describe('when each is called with a fill of a secret', () => {
        test('then it should have none return the secret as text', async () => {
          const exported = await exportsOfTheModule();
          const returned = await Promise.all(
            [...exported.entries()]
              .filter(([name, value]) => name !== 'typeFill' && typeof value === 'function')
              .map(async ([name, value]) => ({ name, value: await callWithAFill(value) })),
          );
          assert.deepEqual(
            returned.filter(({ value }) => typeof value === 'string' && value.includes(secretValue)).map(({ name }) => name),
            [],
          );
        });
      });
    });

    describe('given the input a fill is sent through', () => {
      describe('when typeFill fills a secret and a set of lines', () => {
        test('then it should send the text itself and return none of it', async () => {
          const exported = await exportsOfTheModule();
          const typeFill = exported.get('typeFill');
          assert.ok(typeof typeFill === 'function', 'the module exports typeFill');
          const sent: unknown[][] = [];
          const input = {
            fill: (...given: unknown[]) => {
              sent.push(given);
              return Promise.resolve();
            },
          };
          const secretReturned: unknown = await Promise.resolve(Reflect.apply(typeFill, undefined, [input, element, secretFill, hasStepEnded]));
          const linesReturned: unknown = await Promise.resolve(Reflect.apply(typeFill, undefined, [input, element, linesFill, hasStepEnded]));
          assert.deepEqual(sent, [
            [element, secretValue, hasStepEnded],
            [element, 'one\ntwo', hasStepEnded],
          ]);
          assert.equal(secretReturned, undefined);
          assert.equal(linesReturned, undefined);
        });
      });
    });
  });
}

test('the reveal allow-list names no driver module but the input module', () => {
  const driverModules = revealAllowList().filter((path) => path.startsWith('packages/driver-'));
  assert.deepEqual(driverModules.sort(), DRIVERS.map((driver) => driver.inputModule).sort());
});

// Mutants: the same checks find a planted dependency and a planted second reveal.
test('mutant: the module check reports a planted import, dynamic import and run-time resolution', () => {
  const planted = [
    "import { parse } from 'css-what';",
    "const xpath = await import('xpath');",
    "const serialise = require.resolve('safe-stable-stringify/index.js');",
    "const settled = Promise.resolve('not a package');",
    "import type { Secret } from '@revisum/contracts';",
    "import { readFileSync } from 'node:fs';",
    "import { pageScript } from './page-script.ts';",
  ].join('\n');
  assert.deepEqual(foreignModules(planted, ['@revisum/contracts']), ['css-what', 'xpath', 'safe-stable-stringify/index.js']);
});

test('mutant: the reveal check counts a second call in a page-script path, and ignores comments', () => {
  const planted = [
    "      case 'fill': await operations.fill(element, reveal(typedSecret)); break;",
    '      // reveal(secret) is never called here.',
    '      const result = await page.evaluate(source, { ...scriptArguments, token: reveal(secret) });',
  ].join('\n');
  assert.equal(revealCallLines(planted).length, 2);
});
