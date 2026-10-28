// Runs every *.test.ts file under the given folders with Node's built-in test runner, with no
// retries. A folder that does not exist yet, or holds no tests, is reported and skipped, so the
// same scripts work before and after the first tests land.
// Files that drive a real browser run one at a time, after the rest have run in parallel: the
// test project gives each step 2 seconds, and with several browsers and the other tests sharing
// the CPU a browser's own click or page load can take longer. A browser test is one that imports
// the shared browser module, directly or through other test files; that one rule decides it.
//   node tools/run-test-folder.ts test/unit test/contract
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BROWSER_MODULE = resolve('test/support/browsers.ts');
const RELATIVE_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+)'/g;

// Whether the file imports the browser module, following relative imports.
function drivesBrowser(file: string, seen = new Set<string>()): boolean {
  const path = resolve(file);
  if (path === BROWSER_MODULE) return true;
  if (seen.has(path) || !existsSync(path)) return false;
  seen.add(path);
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const imported = match[1];
    if (imported !== undefined && drivesBrowser(join(dirname(path), imported), seen)) return true;
  }
  return false;
}

function runTests(files: readonly string[], concurrency: number | null): number {
  if (files.length === 0) return 0;
  const limit = concurrency === null ? [] : [`--test-concurrency=${concurrency}`];
  const run = spawnSync(process.execPath, ['--test', ...limit, ...files], { stdio: 'inherit' });
  return run.status ?? 1;
}

function findTestFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...findTestFiles(path));
    else if (/\.test\.(ts|mts|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function main(folders: readonly string[]): number {
  const files: string[] = [];
  for (const folder of folders) {
    const found = findTestFiles(folder);
    if (found.length === 0) console.log(`no tests in ${folder} yet`);
    files.push(...found);
  }
  if (files.length === 0) return 0;
  const browserFiles = files.filter((file) => drivesBrowser(file));
  const otherFiles = files.filter((file) => !browserFiles.includes(file));
  const otherStatus = runTests(otherFiles, null);
  const browserStatus = runTests(browserFiles, 1);
  return otherStatus !== 0 ? otherStatus : browserStatus;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
