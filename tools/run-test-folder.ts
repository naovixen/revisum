// Runs every *.test.ts file under the given folders with Node's built-in test runner, with no
// retries. A folder that does not exist yet, or holds no tests, is reported and skipped, so the
// same scripts work before and after the first tests land.
// Files that drive a real browser run one at a time, after the rest have run in parallel: the
// test project gives each step 2 seconds, and with several browsers and the other tests sharing
// the CPU a browser's own click or page load can take longer. A browser test is one that imports
// the shared browser module, directly or through other test files; that one rule decides it.
// Every test's outcome is written to .test-results/tests-<folders>.jsonl for the gates step
// (tools/test-results-reporter.ts). A file that fails is run once more, only to measure whether
// the run was flaky: the run still fails, whatever the second attempt does.
//   node tools/run-test-folder.ts test/unit test/contract
// The folders are read from the working folder; this tool's own modules from beside it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESULTS_FOLDER, type RerunLine } from './test-results.ts';

const BROWSER_MODULE = resolve('test/support/browsers.ts');
const RELATIVE_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+)'/g;
const REPORTER = pathToFileURL(join(import.meta.dirname, 'test-results-reporter.ts')).href;

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

type Attempt = { readonly status: number; readonly lines: readonly string[] };

// Runs the files once, printing the usual report and collecting the result lines.
function runTests(files: readonly string[], concurrency: number | null, scratchFolder: string): Attempt {
  if (files.length === 0) return { status: 0, lines: [] };
  const destination = mkdtempSync(join(scratchFolder, 'attempt-'));
  const resultsPath = join(destination, 'results.jsonl');
  const limit = concurrency === null ? [] : [`--test-concurrency=${concurrency}`];
  const reporters = [
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${resultsPath}`,
  ];
  const run = spawnSync(process.execPath, ['--test', ...limit, ...reporters, ...files], { stdio: 'inherit' });
  const text = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : '';
  return { status: run.status ?? 1, lines: text.split('\n').filter((line) => line.trim() !== '') };
}

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

// The files with a test that failed (not skipped), as the reporter wrote them.
function failedFiles(lines: readonly string[]): Set<string> {
  const files = new Set<string>();
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    const file = fieldOf(value, 'file');
    if (typeof file === 'string' && fieldOf(value, 'passed') === false && fieldOf(value, 'skipped') === false) files.add(file);
  }
  return files;
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

// The results file for this set of folders: running the same folders again replaces it.
function resultsFileFor(folders: readonly string[]): string {
  const key = folders.map((folder) => relative('.', folder).split(sep).join('-').replace(/[^\w.-]+/g, '-')).join('+');
  return join(RESULTS_FOLDER, `tests-${key === '' ? 'none' : key}.jsonl`);
}

function main(folders: readonly string[]): number {
  const files: string[] = [];
  for (const folder of folders) {
    const found = findTestFiles(folder);
    if (found.length === 0) console.log(`no tests in ${folder} yet`);
    files.push(...found);
  }
  mkdirSync(RESULTS_FOLDER, { recursive: true });
  const resultsFile = resultsFileFor(folders);
  if (files.length === 0) {
    writeFileSync(resultsFile, '');
    return 0;
  }
  const scratchFolder = mkdtempSync(join(tmpdir(), 'revisum-test-results-'));
  try {
    const browserFiles = files.filter((file) => drivesBrowser(file));
    const otherFiles = files.filter((file) => !browserFiles.includes(file));
    const other = runTests(otherFiles, null, scratchFolder);
    const browser = runTests(browserFiles, 1, scratchFolder);
    const lines = [...other.lines, ...browser.lines];

    // The measuring rerun: each failed file once more, on its own. It never changes the status.
    const reruns: RerunLine[] = [];
    for (const file of [...failedFiles(lines)].sort()) {
      console.log(`\nrunning ${file} once more to measure flakiness; the run fails whatever this attempt does`);
      const rerun = runTests([file], 1, scratchFolder);
      reruns.push({ kind: 'rerun', file, passed: rerun.status === 0 });
    }
    const rerunLines = reruns.map((rerun) => JSON.stringify(rerun));
    writeFileSync(resultsFile, [...lines, ...rerunLines].map((line) => `${line}\n`).join(''));
    if (reruns.some((rerun) => rerun.passed)) console.log('flaky: a failed file passed when run again; the run still fails');
    return other.status !== 0 ? other.status : browser.status;
  } finally {
    rmSync(scratchFolder, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
