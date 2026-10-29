// No third-party browser automation library reaches the default runtime set: every package except
// driver-playwright, the optional fallback adapter. `node tools/check-runtime-imports.ts` reads
// the packages under packages/ of its working folder, and fails, naming the package and the
// library, when a package of the default set imports one (a static or dynamic import, a
// re-export or a require, including a sub-path such as playwright-core/lib/server) or declares one
// as a dependency. The banned libraries are playwright, playwright-core, puppeteer,
// puppeteer-core, webdriverio, selenium-webdriver and chrome-remote-interface.
// The fixture repositories under fixtures/runtime-imports/ are a clean set (driver-playwright
// using playwright-core, and the word "playwright" kept as data), and the same set with banned
// imports or dependencies planted. `npm run check` runs the lint, and the repository passes it.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FIXTURES, REPOSITORY_ROOT } from '../support/repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const TOOL = 'check-runtime-imports.ts';
const fixture = (name: string): string => join(FIXTURES, 'runtime-imports', name);
const lint = (root: string): ToolRun => runTool(TOOL, [], { cwd: root });

const BANNED = [
  'playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'webdriverio', 'selenium-webdriver', 'chrome-remote-interface',
] as const;

const scratchFolders: string[] = [];
after(() => { for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true }); });

// A throw-away copy of the clean fixture repository with one file added.
function cleanCopyWith(path: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-imports-'));
  scratchFolders.push(root);
  cpSync(fixture('clean'), root, { recursive: true });
  writeFileSync(join(root, path), content);
  return root;
}

// The run failed, and one line of its output names both the package folder and the library.
function assertReported(run: ToolRun, packageFolder: string, library: string): void {
  assert.equal(run.passed, false, describeRun(run));
  // The library's name standing alone, so playwright is not found inside playwright-core or driver-playwright.
  const libraryName = new RegExp(`(?<![\\w@/.-])${library}(?![\\w-])`);
  const named = run.output.split('\n').some((line) => line.includes(packageFolder) && libraryName.test(line));
  assert.ok(named, `no line names ${packageFolder} and ${library}:\n${describeRun(run)}`);
}

test('the clean fixture set passes: only the fallback adapter uses Playwright, and the word alone is data', { criterion: 'AC-SPEC-06-06' }, () => {
  const run = lint(fixture('clean'));
  assert.equal(run.passed, true, describeRun(run));
});

test('the repository\'s own default runtime set passes', { criterion: 'AC-SPEC-06-06' }, () => {
  const run = lint(REPOSITORY_ROOT);
  assert.equal(run.passed, true, describeRun(run));
});

test('npm run check runs the runtime import lint', { criterion: 'AC-SPEC-06-06' }, () => {
  const manifest: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  // `check` runs `check:tests`, which runs `lint`.
  assert.ok(scripts['check']?.includes('check:tests'), 'check runs check:tests');
  assert.ok(scripts['check:tests']?.includes('npm run lint'), 'check:tests runs lint');
  assert.ok(scripts['lint']?.includes(`node tools/${TOOL}`), `lint runs tools/${TOOL}`);
});

test('every banned import in the default set is reported, by package and library', { criterion: 'AC-SPEC-06-06' }, () => {
  const run = lint(fixture('banned-imports'));
  for (const [packageFolder, library] of [
    ['report', 'playwright'], ['cli', 'puppeteer-core'], ['runner', 'webdriverio'], ['auditor-act', 'selenium-webdriver'],
    ['action', 'chrome-remote-interface'], ['driver-cdp', 'puppeteer'], ['auditor-axe', 'playwright-core'],
  ] as const) {
    assertReported(run, packageFolder, library);
  }
});

test('a banned library declared as a dependency fails, even with no import of it', { criterion: 'AC-SPEC-06-06' }, () => {
  const run = lint(fixture('declared-dependency'));
  assertReported(run, 'runner', 'puppeteer');
  assertReported(run, 'report', 'chrome-remote-interface');
});

for (const library of BANNED) {
  test(`mutant: one planted import of ${library} in the clean set fails the lint`, { criterion: 'AC-SPEC-06-06' }, () => {
    const run = lint(cleanCopyWith('packages/report/src/planted.ts', `import { launch } from '${library}';\nexport const planted = launch;\n`));
    assertReported(run, 'report', library);
  });
}

test('mutant: a sub-path import of a banned library fails the lint', { criterion: 'AC-SPEC-06-06' }, () => {
  const run = lint(cleanCopyWith('packages/report/src/planted.ts', "export { launchServer } from 'playwright-core/lib/server';\n"));
  assertReported(run, 'report', 'playwright-core');
});
