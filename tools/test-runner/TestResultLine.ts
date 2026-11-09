// A reporter for Node's test runner that writes one JSON line per finished test, so the gates
// step can tell which tests ran and passed without parsing human-readable output. Each line holds
// the test's file (relative to the working folder, with forward slashes), its full name (suite
// names and its own joined by " > "), the line of its call, whether it passed and how long it took.
// Suites are not written: a suite passes only when its tests do. A file that fails before any of
// its tests run (a syntax error, a missing import) is written as one failed test named after the
// file. tools/test-runner/RunTestFolder.ts passes this module to `node --test --test-reporter`.
import { relative, sep } from 'node:path';

// One line of a results file, as tools/test-runner/ReadTestResults.ts reads it back.
export type TestResultLine = {
  readonly kind: 'test';
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly passed: boolean;
  // Skipped and to-do tests neither pass nor fail the run.
  readonly skipped: boolean;
  readonly durationMilliseconds: number;
};

type ReporterEvent = { readonly type: string; readonly data?: unknown };

type EventFields = {
  readonly name: string;
  readonly nesting: number;
  readonly file: string;
  readonly line: number;
  readonly skipped: boolean;
  readonly isSuite: boolean;
  readonly durationMilliseconds: number;
};

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

// The fields this reporter needs from one runner event, or undefined when it has none of them.
function readEvent(data: unknown): EventFields | undefined {
  const name = fieldOf(data, 'name');
  const nesting = fieldOf(data, 'nesting');
  const file = fieldOf(data, 'file');
  if (typeof name !== 'string' || typeof nesting !== 'number' || typeof file !== 'string') return undefined;
  const line = fieldOf(data, 'line');
  const details = fieldOf(data, 'details');
  const duration = fieldOf(details, 'duration_ms');
  const skip = fieldOf(data, 'skip');
  const todo = fieldOf(data, 'todo');
  return {
    name,
    nesting,
    file: relative(process.cwd(), file).split(sep).join('/'),
    line: typeof line === 'number' ? line : 0,
    // Node gives the reason as text, or true when there is none.
    skipped: (skip !== undefined && skip !== false) || (todo !== undefined && todo !== false),
    isSuite: fieldOf(details, 'type') === 'suite',
    durationMilliseconds: typeof duration === 'number' ? Math.round(duration) : 0,
  };
}

export default async function* testResultsReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  // Node names as a test's file the module that called test(), which for a shared contract is a
  // module under test/support, not the test file that runs it. The test file is the one its
  // top-level suite was declared in. Node reports each file's events as one unbroken block, a
  // test's start before its result, so the latest top-level start names the file a result
  // belongs to, and one stack holds the names of the suites it runs in, by nesting depth.
  const openNames: string[] = [];
  let testFile = '';
  for await (const event of source) {
    const fields = readEvent(event.data);
    if (fields === undefined) continue;
    if (event.type === 'test:start') {
      if (fields.nesting === 0) {
        testFile = fields.file;
      }
      openNames.length = fields.nesting;
      openNames.push(fields.name);
    } else if ((event.type === 'test:pass' || event.type === 'test:fail') && !fields.isSuite) {
      const line: TestResultLine = {
        kind: 'test',
        // A top-level result is its own file's, which also covers a file that failed to load.
        file: fields.nesting === 0 ? fields.file : testFile,
        name: [...openNames.slice(0, fields.nesting), fields.name].join(' > '),
        line: fields.line,
        passed: event.type === 'test:pass' && !fields.skipped,
        skipped: fields.skipped,
        durationMilliseconds: fields.durationMilliseconds,
      };
      yield `${JSON.stringify(line)}\n`;
    }
  }
}
