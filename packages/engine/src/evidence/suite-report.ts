// Decodes a Playwright Test JSON report, which arrives as unknown, by hand and under the evidence
// limits. Two passes: the first walks the whole value once, refusing what no report may hold
// (nesting past the depth limit, more bytes than the size limit, a key such as "__proto__" that
// could pollute a prototype, a value JSON cannot hold); the second reads the fields Revisum uses,
// checking each one's type, and ignores the rest. There is no version gate: these shape checks are
// the gate, and a report they do not fit is refused, never guessed at.
//
// Every refusal is a bare code and JSON path. Neither ever holds text from the report: the paths
// name only the fields this decoder reads, and any other key is written "*".
// See docs/specs/SPEC-35-evidence-mode.md.
import { Buffer } from 'node:buffer';
import { failure, success, type Brand, type EvidenceLimits, type Result, type SuiteTestOutcome } from '@revisum/contracts';
import { brand } from '../brand.ts';
import { INVALID, allValid, type Parsed } from '../plan/plan-decoders.ts';
import { staysInside } from '../relative-paths.ts';

// Why a suite's output was refused.
//   suite-report-missing: the suite wrote no report.
//   suite-report-invalid: the report does not have the shape of a Playwright Test JSON report.
//   suite-report-unsupported: the report comes from a reporter or version Revisum does not read.
//   trace-invalid, trace-unsupported: the same, for a trace archive.
//   too-large: the output is over a size, count or depth limit.
export type SuiteDecodeErrorCode =
  | 'suite-report-missing' | 'suite-report-invalid' | 'suite-report-unsupported' | 'trace-invalid' | 'trace-unsupported' | 'too-large';
export type SuiteDecodeError = { readonly code: SuiteDecodeErrorCode; readonly path: string };

// How deeply a report may nest when the project sets no maximumReportDepth.
export const DEFAULT_REPORT_DEPTH = 64;

export type SuiteAnnotation = { readonly type: string; readonly description?: string };
export type SuiteErrorLocation = { readonly file: string; readonly line: number; readonly column: number };
export type SuiteReportError = { readonly message?: string; readonly location?: SuiteErrorLocation };
// A file the suite attached to a result, such as its trace, relative to Revisum's output directory.
export type SuiteAttachment = { readonly name: string; readonly contentType: string; readonly path?: string };

// One test in one project, as the report gives it. Text is as the report holds it: the result
// builder redacts it before anything keeps it.
export type SuiteReportTest = {
  readonly file: string;
  // The describe titles, then the test's own. The file's own suite is left out: `file` names it.
  readonly titlePath: readonly string[];
  readonly project: string;
  readonly outcome: SuiteTestOutcome;
  readonly annotations: readonly SuiteAnnotation[];
  readonly errors: readonly SuiteReportError[];
  readonly attachments: readonly SuiteAttachment[];
  readonly durationMilliseconds: number;
};
// Only parseSuiteReport makes one, so a result can be built only from a decoded report.
// `playwrightVersion` is what the report says ran it: self-reported, kept only when it looks like a version.
export type SuiteReport = Brand<SuiteReportFields, 'SuiteReport'>;
type SuiteReportFields = { readonly tests: readonly SuiteReportTest[]; readonly playwrightVersion?: string };

// What a trace archive held: the attachment path it was read from, the test's actions in order,
// and the browser and Playwright version the trace says recorded it, which Revisum cannot check.
// Only parseSuiteTrace makes one.
export type SuiteTrace = Brand<{
  readonly attachmentPath: string; readonly actions: readonly string[]; readonly browserName?: string; readonly playwrightVersion?: string;
}, 'SuiteTrace'>;

// Where the suite's process saw Revisum's output folder. An attachment path under it is read as
// relative to the folder, since Playwright writes absolute paths.
export type SuiteReportOptions = { readonly outputDirectory?: string };

// Playwright's result statuses, each mapped to its outcome.
const RESULT_OUTCOMES: Readonly<Record<string, SuiteTestOutcome>> = {
  passed: 'passed', failed: 'failed', timedOut: 'timed-out', skipped: 'skipped', interrupted: 'interrupted',
};
// The statuses a suite may expect a test to end with: "failed" for a test marked test.fail().
const EXPECTED_STATUSES: readonly string[] = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];
// A self-reported Playwright version is kept only when it looks like one.
const VERSION_TEXT = /^\d{1,4}\.\d{1,4}\.\d{1,4}([-+.][0-9A-Za-z.-]{1,32})?$/;
// Playwright's statuses for a test as a whole. "flaky" is left out on purpose: with --retries=0 a
// test runs once, so a report claiming a flaky test is not to be believed.
const TEST_STATUSES: readonly string[] = ['expected', 'unexpected', 'skipped'];
// Keys that would reach an object's prototype if code ever assigned them.
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
// The keys this decoder reads, which a refusal's path may name. Any other key is written "*".
const READ_KEYS: ReadonlySet<string> = new Set([
  'suites', 'specs', 'tests', 'results', 'title', 'file', 'projectName', 'annotations', 'type', 'description', 'status', 'errors',
  'message', 'location', 'line', 'column', 'attachments', 'name', 'contentType', 'path', 'duration', 'expectedStatus', 'config', 'version',
  ...PROTOTYPE_KEYS,
]);

export function parseSuiteReport(
  input: unknown, limits: EvidenceLimits, options: SuiteReportOptions = {},
): Result<SuiteReport, readonly SuiteDecodeError[]> {
  const walked = walk(input, limits);
  if (walked !== undefined) return failure([walked]);
  const outputPrefix = options.outputDirectory === undefined ? undefined : `${options.outputDirectory.replace(/\/+$/, '')}/`;
  const context: DecodeContext = { issues: [], tests: [], maximumTests: limits.maximumTests, outputPrefix };
  const report = readObject(input, '$', context);
  if (report === INVALID) return failure(context.issues);
  const suites = readList(report['suites'], '$.suites', context);
  if (suites !== INVALID) suites.forEach((suite, index) => readSuite(suite, `$.suites[${index}]`, undefined, context));
  if (context.issues.length > 0) return failure(context.issues);
  const playwrightVersion = reportedVersion(report['config']);
  return success(brand<SuiteReportFields, 'SuiteReport'>({ tests: context.tests, ...(playwrightVersion === undefined ? {} : { playwrightVersion }) }));
}

// The Playwright version the report's config gives, when it is there and looks like one. It only
// labels the run, so a report without one is not refused.
function reportedVersion(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const version: unknown = Object.getOwnPropertyDescriptor(config, 'version')?.value;
  return typeof version === 'string' && VERSION_TEXT.test(version) ? version : undefined;
}

// ---- The first pass: limits and keys over the whole value --------------------------------------

type WalkState = { bytes: number; readonly maximumBytes: number; readonly maximumDepth: number };

// The first thing no report may hold, or undefined. The size counted is that of the value written
// as compact JSON, and the walk stops as soon as it is over, so an oversized report costs no more
// than the limit to refuse.
function walk(input: unknown, limits: EvidenceLimits): SuiteDecodeError | undefined {
  const state: WalkState = { bytes: 0, maximumBytes: limits.maximumReportBytes, maximumDepth: limits.maximumReportDepth ?? DEFAULT_REPORT_DEPTH };
  return walkValue(input, ['$'], state);
}

// `segments` is the path so far, kept as a list and joined only for a refusal.
function walkValue(value: unknown, segments: string[], state: WalkState): SuiteDecodeError | undefined {
  // Every nested list or object adds one segment, so the depth is the path's length.
  if (segments.length > state.maximumDepth) return { code: 'too-large', path: segments.join('') };
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) return invalidAt(segments);
    state.bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    return state.bytes > state.maximumBytes ? tooLarge() : undefined;
  }
  if (Array.isArray(value)) {
    state.bytes += 1 + Math.max(value.length, 1);
    for (const [index, item] of value.entries()) {
      segments.push(`[${index}]`);
      const found = walkValue(item, segments, state);
      segments.pop();
      if (found !== undefined) return found;
    }
    return state.bytes > state.maximumBytes ? tooLarge() : undefined;
  }
  if (typeof value !== 'object' || !isPlainObject(value)) return invalidAt(segments);
  const keys = Object.keys(value);
  state.bytes += 1 + Math.max(keys.length, 1);
  for (const key of keys) {
    segments.push(`.${READ_KEYS.has(key) ? key : '*'}`);
    if (PROTOTYPE_KEYS.includes(key)) return invalidAt(segments);
    state.bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
    const found = walkValue(Object.getOwnPropertyDescriptor(value, key)?.value, segments, state);
    segments.pop();
    if (found !== undefined) return found;
  }
  return state.bytes > state.maximumBytes ? tooLarge() : undefined;
}

const invalidAt = (segments: readonly string[]): SuiteDecodeError => ({ code: 'suite-report-invalid', path: segments.join('') });
const tooLarge = (): SuiteDecodeError => ({ code: 'too-large', path: '$' });

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// ---- The second pass: the fields Revisum reads ---------------------------------------------------

type DecodeContext = {
  readonly issues: SuiteDecodeError[]; readonly tests: SuiteReportTest[]; readonly maximumTests: number;
  // The output folder as the suite saw it, ending in "/", when attachment paths may be absolute under it.
  readonly outputPrefix: string | undefined;
};
type Fields = Readonly<Record<string, unknown>>;

function refuse(path: string, context: DecodeContext): typeof INVALID {
  context.issues.push({ code: 'suite-report-invalid', path });
  return INVALID;
}

function readObject(input: unknown, path: string, context: DecodeContext): Parsed<Fields> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse(path, context);
  return Object.fromEntries(Object.entries(input));
}

function readList(input: unknown, path: string, context: DecodeContext): Parsed<readonly unknown[]> {
  return Array.isArray(input) ? input : refuse(path, context);
}

// A list that may be left out, which reads as empty.
const readOptionalList = (fields: Fields, key: string, path: string, context: DecodeContext): Parsed<readonly unknown[]> =>
  Object.hasOwn(fields, key) ? readList(fields[key], `${path}.${key}`, context) : [];

function readString(input: unknown, path: string, context: DecodeContext): Parsed<string> {
  return typeof input === 'string' ? input : refuse(path, context);
}

const readOptionalString = (fields: Fields, key: string, path: string, context: DecodeContext): Parsed<string | undefined> =>
  Object.hasOwn(fields, key) ? readString(fields[key], `${path}.${key}`, context) : undefined;

function readCount(input: unknown, path: string, context: DecodeContext): Parsed<number> {
  return typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : refuse(path, context);
}

// A file's suite, or a describe block inside one. `describeTitles` are the titles of the describe
// blocks around it, and undefined for a file's own suite, whose title is the file name and so is
// not part of a test's title path.
function readSuite(input: unknown, path: string, describeTitles: readonly string[] | undefined, context: DecodeContext): void {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return;
  const title = readString(fields['title'], `${path}.title`, context);
  const specs = readList(fields['specs'], `${path}.specs`, context);
  const suites = readOptionalList(fields, 'suites', path, context);
  if (title === INVALID) return;
  const titles = describeTitles === undefined ? [] : [...describeTitles, title];
  if (specs !== INVALID) specs.forEach((spec, index) => readSpec(spec, `${path}.specs[${index}]`, titles, context));
  if (suites !== INVALID) suites.forEach((suite, index) => readSuite(suite, `${path}.suites[${index}]`, titles, context));
}

// A test as written in a file: one entry per project it ran in.
function readSpec(input: unknown, path: string, describeTitles: readonly string[], context: DecodeContext): void {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return;
  const title = readString(fields['title'], `${path}.title`, context);
  const file = readString(fields['file'], `${path}.file`, context);
  const tests = readList(fields['tests'], `${path}.tests`, context);
  if (title === INVALID || file === INVALID || tests === INVALID) return;
  for (const [index, test] of tests.entries()) {
    if (context.tests.length >= context.maximumTests) {
      // One refusal is enough: the rest of the report is not read.
      if (!context.issues.some((issue) => issue.code === 'too-large')) context.issues.push({ code: 'too-large', path: '$' });
      return;
    }
    const decoded = readTest(test, `${path}.tests[${index}]`, { file, titlePath: [...describeTitles, title] }, context);
    if (decoded !== INVALID) context.tests.push(decoded);
  }
}

function readTest(
  input: unknown, path: string, spec: { readonly file: string; readonly titlePath: readonly string[] }, context: DecodeContext,
): Parsed<SuiteReportTest> {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return INVALID;
  const project = readString(fields['projectName'], `${path}.projectName`, context);
  const rawAnnotations = readOptionalList(fields, 'annotations', path, context);
  const annotations = rawAnnotations === INVALID
    ? INVALID : rawAnnotations.map((annotation, index) => readAnnotation(annotation, `${path}.annotations[${index}]`, context));
  const status = fields['status'];
  const knownStatus = typeof status === 'string' && TEST_STATUSES.includes(status) ? status : refuse(`${path}.status`, context);
  const expected = fields['expectedStatus'];
  const expectedStatus = expected === undefined || (typeof expected === 'string' && EXPECTED_STATUSES.includes(expected))
    ? expected : refuse(`${path}.expectedStatus`, context);
  const result = readOnlyResult(fields['results'], `${path}.results`, context);
  if (project === INVALID || annotations === INVALID || !allValid(annotations) || knownStatus === INVALID || expectedStatus === INVALID
    || result === INVALID) return INVALID;
  // A test the suite expects to fail, which failed, is Playwright's "expected" outcome: kept apart
  // from both a pass and an ordinary failure.
  const outcome: SuiteTestOutcome = expectedStatus === 'failed' && result.outcome === 'failed' ? 'expected-failure' : result.outcome;
  return { ...spec, project, annotations, ...result, outcome };
}

function readAnnotation(input: unknown, path: string, context: DecodeContext): Parsed<SuiteAnnotation> {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return INVALID;
  const type = readString(fields['type'], `${path}.type`, context);
  const description = readOptionalString(fields, 'description', path, context);
  if (type === INVALID || description === INVALID) return INVALID;
  return description === undefined ? { type } : { type, description };
}

type ResultParts = Pick<SuiteReportTest, 'outcome' | 'errors' | 'attachments' | 'durationMilliseconds'>;

// With --retries=0 a test runs at most once, so it has at most one result. A test with none never
// finished, which counts as interrupted, so it can never pass.
function readOnlyResult(input: unknown, path: string, context: DecodeContext): Parsed<ResultParts> {
  const results = readList(input, path, context);
  if (results === INVALID) return INVALID;
  if (results.length > 1) return refuse(path, context);
  if (results.length === 0) return { outcome: 'interrupted', errors: [], attachments: [], durationMilliseconds: 0 };
  const resultPath = `${path}[0]`;
  const fields = readObject(results[0], resultPath, context);
  if (fields === INVALID) return INVALID;
  const status = fields['status'];
  const outcome = typeof status === 'string' && Object.hasOwn(RESULT_OUTCOMES, status) ? RESULT_OUTCOMES[status] : undefined;
  if (outcome === undefined) refuse(`${resultPath}.status`, context);
  const rawErrors = readOptionalList(fields, 'errors', resultPath, context);
  const errors = rawErrors === INVALID ? INVALID : rawErrors.map((error, index) => readError(error, `${resultPath}.errors[${index}]`, context));
  const rawAttachments = readOptionalList(fields, 'attachments', resultPath, context);
  const attachments = rawAttachments === INVALID
    ? INVALID : rawAttachments.map((attachment, index) => readAttachment(attachment, `${resultPath}.attachments[${index}]`, context));
  const duration = fields['duration'];
  const durationMilliseconds = duration === undefined ? 0
    : typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : refuse(`${resultPath}.duration`, context);
  if (outcome === undefined || errors === INVALID || !allValid(errors) || attachments === INVALID || !allValid(attachments)
    || durationMilliseconds === INVALID) return INVALID;
  return { outcome, errors, attachments, durationMilliseconds };
}

function readError(input: unknown, path: string, context: DecodeContext): Parsed<SuiteReportError> {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return INVALID;
  const message = readOptionalString(fields, 'message', path, context);
  const location = Object.hasOwn(fields, 'location') ? readLocation(fields['location'], `${path}.location`, context) : undefined;
  if (message === INVALID || location === INVALID) return INVALID;
  return { ...(message === undefined ? {} : { message }), ...(location === undefined ? {} : { location }) };
}

function readLocation(input: unknown, path: string, context: DecodeContext): Parsed<SuiteErrorLocation> {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return INVALID;
  const parts = [
    readString(fields['file'], `${path}.file`, context),
    readCount(fields['line'], `${path}.line`, context),
    readCount(fields['column'], `${path}.column`, context),
  ] as const;
  return allValid(parts) ? { file: parts[0], line: parts[1], column: parts[2] } : INVALID;
}

// An attachment's path must stay inside Revisum's output directory, which it is relative to.
// An attachment carried inline, with no path, is fine.
function readAttachment(input: unknown, path: string, context: DecodeContext): Parsed<SuiteAttachment> {
  const fields = readObject(input, path, context);
  if (fields === INVALID) return INVALID;
  const name = readString(fields['name'], `${path}.name`, context);
  const contentType = readString(fields['contentType'], `${path}.contentType`, context);
  const written = readOptionalString(fields, 'path', path, context);
  const prefix = context.outputPrefix;
  const filePath = written !== INVALID && written !== undefined && prefix !== undefined && written.startsWith(prefix) ? written.slice(prefix.length) : written;
  const inside = filePath === INVALID || filePath === undefined || staysInside(filePath) ? filePath : refuse(`${path}.path`, context);
  if (name === INVALID || contentType === INVALID || inside === INVALID) return INVALID;
  return inside === undefined ? { name, contentType } : { name, contentType, path: inside };
}
