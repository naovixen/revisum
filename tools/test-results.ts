// The results of the test runs, as tools/run-test-folder.ts leaves them in .test-results/, read
// back for the gates step. Each run of run-test-folder writes one results file for the folders it
// ran, replacing that file's earlier version; the gates step reads them all.
//   - A test id is "<file>#<full name>", the file relative to the repository with forward slashes.
//   - A test's criterion is read from its source at the line Node reported, the way the naming
//     lint reads it: the string after `criterion:` in the test's options.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize, type Token } from './lint-names.ts';
import type { TestResultLine } from './test-results-reporter.ts';

export const RESULTS_FOLDER = '.test-results';
// Results files are "tests-<folders>.jsonl"; other files in the folder are the gates' own output.
const RESULTS_FILE = /^tests-.*\.jsonl$/;

export type TestResult = TestResultLine & { readonly testId: string };

// A file that failed on its first attempt and was run once more, only to measure flakiness.
export type RerunLine = { readonly kind: 'rerun'; readonly file: string; readonly passed: boolean };

export type TestResults = {
  // Every test of the first attempts, by test id. When two results files hold the same test, the
  // newer file's result counts.
  readonly tests: ReadonlyMap<string, TestResult>;
  readonly reruns: readonly RerunLine[];
  // The results files read, relative to the repository.
  readonly files: readonly string[];
};

export const testIdOf = (file: string, name: string): string => `${file}#${name}`;

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

// One line of a results file, or undefined when it is not one this module writes.
function decodeLine(text: string): TestResultLine | RerunLine | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const kind = fieldOf(value, 'kind');
  const file = fieldOf(value, 'file');
  const passed = fieldOf(value, 'passed');
  if (typeof file !== 'string' || typeof passed !== 'boolean') return undefined;
  if (kind === 'rerun') return { kind, file, passed };
  const name = fieldOf(value, 'name');
  const line = fieldOf(value, 'line');
  const skipped = fieldOf(value, 'skipped');
  const duration = fieldOf(value, 'durationMilliseconds');
  if (kind !== 'test' || typeof name !== 'string' || typeof line !== 'number' || typeof skipped !== 'boolean' || typeof duration !== 'number') return undefined;
  return { kind, file, name, line, passed, skipped, durationMilliseconds: duration };
}

export function readTestResults(root: string): TestResults {
  const folder = join(root, RESULTS_FOLDER);
  const names = existsSync(folder) ? readdirSync(folder).filter((name) => RESULTS_FILE.test(name)) : [];
  // Oldest first, so a newer run of the same tests replaces an older one.
  const ordered = names
    .map((name) => ({ name, modified: statSync(join(folder, name)).mtimeMs }))
    .sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name));
  const tests = new Map<string, TestResult>();
  const reruns: RerunLine[] = [];
  for (const { name } of ordered) {
    for (const text of readFileSync(join(folder, name), 'utf8').split('\n')) {
      if (text.trim() === '') continue;
      const line = decodeLine(text);
      if (line === undefined) continue;
      if (line.kind === 'rerun') reruns.push(line);
      else {
        const testId = testIdOf(line.file, line.name);
        tests.set(testId, { ...line, testId });
      }
    }
  }
  return { tests, reruns, files: ordered.map(({ name }) => `${RESULTS_FOLDER}/${name}`) };
}

// True when a test that ran in these results failed (skipped tests neither pass nor fail).
export const failed = (test: TestResult): boolean => !test.passed && !test.skipped;

// ---- Criteria in test metadata ------------------------------------------------------------------

const isPunctuator = (token: Token | undefined, text: string): boolean => token?.kind === 'punctuator' && token.text === text;

// The criterion id in the options of the test call that starts on `line`, or undefined. The scan
// starts at that line and stops at the test's body: the first arrow or `function` keyword.
export function criterionAt(tokens: readonly Token[], line: number): string | undefined {
  const start = tokens.findIndex((token) => token.line >= line);
  if (start === -1) return undefined;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isPunctuator(token, '=') && isPunctuator(tokens[index + 1], '>')) break;
    if (token.kind === 'identifier' && token.text === 'function') break;
    const value = tokens[index + 2];
    if (token.kind === 'identifier' && token.text === 'criterion' && isPunctuator(tokens[index + 1], ':') && value?.kind === 'string') {
      return value.text;
    }
  }
  return undefined;
}

// Reads criteria for test results, tokenizing each source file once.
export function criterionReader(root: string): (test: TestResultLine) => string | undefined {
  const tokensByFile = new Map<string, readonly Token[]>();
  return (test) => {
    let tokens = tokensByFile.get(test.file);
    if (tokens === undefined) {
      const path = join(root, test.file);
      tokens = existsSync(path) ? tokenize(readFileSync(path, 'utf8')).filter((token) => token.kind !== 'comment') : [];
      tokensByFile.set(test.file, tokens);
    }
    return criterionAt(tokens, test.line);
  };
}
