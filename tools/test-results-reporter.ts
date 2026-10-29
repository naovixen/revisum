// A reporter for Node's test runner that writes one JSON line per finished test, so the gates
// step can tell which tests ran and passed without parsing human-readable output. Each line holds
// the test's file (relative to the working folder, with forward slashes), its full name (suite
// names and its own joined by " > "), the line of its call, whether it passed and how long it took.
// Suites are not written: a suite passes only when its tests do. A file that fails before any of
// its tests run (a syntax error, a missing import) is written as one failed test named after the
// file. tools/run-test-folder.ts passes this module to `node --test --test-reporter`.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { relative, sep } from 'node:path';

// One line of a results file, as tools/test-results.ts reads it back.
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
  // The names of the suites a test runs in, per file, by nesting depth. Node reports a test's
  // start, then its result, in order within a file, so the stack is right when a result arrives.
  const openNames = new Map<string, string[]>();
  for await (const event of source) {
    const fields = readEvent(event.data);
    if (fields === undefined) continue;
    const names = openNames.get(fields.file) ?? [];
    openNames.set(fields.file, names);
    if (event.type === 'test:start') {
      names.length = fields.nesting;
      names.push(fields.name);
    } else if ((event.type === 'test:pass' || event.type === 'test:fail') && !fields.isSuite) {
      const line: TestResultLine = {
        kind: 'test',
        file: fields.file,
        name: [...names.slice(0, fields.nesting), fields.name].join(' > '),
        line: fields.line,
        passed: event.type === 'test:pass' && !fields.skipped,
        skipped: fields.skipped,
        durationMilliseconds: fields.durationMilliseconds,
      };
      yield `${JSON.stringify(line)}\n`;
    }
  }
}
