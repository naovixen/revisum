// parseSuiteReport decodes a Playwright Test JSON report, which arrives as unknown, by hand and
// under the evidence limits. A hostile or malformed report is refused with a code and a JSON
// path, and never with the value that caused it: wrong types, statuses it does not know, a report
// claiming a flaky test (impossible with --retries=0), nesting past the depth limit, more tests
// than maximumTests, a report over maximumReportBytes, __proto__ and constructor keys, and
// attachment paths that leave Revisum's output directory.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTACHMENT_INSIDE_OUTPUT, HOSTILE_MARKER, decodeReport, decodedReport, evidenceLimits, recordedReport, refusal, specJsonPath, specPath,
  type JsonRecord,
} from './evidence-examples.ts';
import { withValue } from './plan-examples.ts';

const TEST_PATH = (spec: number): (string | number)[] => [...specPath(spec), 'tests', 0];
const TEST_JSON_PATH = (spec: number): string => `${specJsonPath(spec)}.tests[0]`;
const RESULT_PATH = (spec: number): (string | number)[] => [...TEST_PATH(spec), 'results', 0];
const RESULT_JSON_PATH = (spec: number): string => `${TEST_JSON_PATH(spec)}.results[0]`;

// Exactly the code at the path, and every error a bare { code, path }.
function assertRefusedAt(report: unknown, code: string, path: string, limits = evidenceLimits()): void {
  const errors = refusal(report, limits);
  assert.ok(errors.some((error) => error.code === code && error.path === path), `expected ${code} at ${path}, got ${JSON.stringify(errors)}`);
  for (const error of errors) assert.deepEqual(Object.keys(error).sort(), ['code', 'path'], JSON.stringify(error));
}

// ---- The recorded reports decode (the counter-example for every refusal below) --------------------

test('both recorded reports decode under the default limits', { criterion: 'AC-SPEC-35-09' }, () => {
  decodedReport(recordedReport('each-outcome'));
  decodedReport(recordedReport('passing-with-criteria'));
});

test('a report whose attachment path stays inside the output directory decodes', { criterion: 'AC-SPEC-35-09' }, () => {
  const attachment = { name: 'trace', contentType: 'application/zip', path: ATTACHMENT_INSIDE_OUTPUT };
  decodedReport(withValue(recordedReport('each-outcome'), [...RESULT_PATH(1), 'attachments'], [attachment]));
});

// ---- Wrong types and unknown statuses ------------------------------------------------------------

type HostileCase = { readonly name: string; readonly report: () => unknown; readonly path: string };

const edited = (path: (string | number)[], value: unknown) => (): JsonRecord => withValue(recordedReport('each-outcome'), path, value);

const WRONG_TYPES: readonly HostileCase[] = [
  { name: 'a report that is text', report: () => HOSTILE_MARKER, path: '$' },
  { name: 'a report that is a list', report: () => [HOSTILE_MARKER], path: '$' },
  { name: 'a report that is null', report: () => null, path: '$' },
  { name: 'suites that are text', report: edited(['suites'], HOSTILE_MARKER), path: '$.suites' },
  { name: 'specs that are an object', report: edited([...specPath(0).slice(0, -1)], { first: HOSTILE_MARKER }), path: '$.suites[0].suites[0].specs' },
  { name: 'a spec title that is a number', report: edited([...specPath(0), 'title'], 42), path: `${specJsonPath(0)}.title` },
  { name: 'a spec file that is a list', report: edited([...specPath(0), 'file'], [HOSTILE_MARKER]), path: `${specJsonPath(0)}.file` },
  { name: 'a project name that is an object', report: edited([...TEST_PATH(0), 'projectName'], { name: HOSTILE_MARKER }), path: `${TEST_JSON_PATH(0)}.projectName` },
  { name: 'annotations that are text', report: edited([...TEST_PATH(0), 'annotations'], HOSTILE_MARKER), path: `${TEST_JSON_PATH(0)}.annotations` },
  { name: 'an annotation type that is a number', report: edited([...TEST_PATH(0), 'annotations', 0, 'type'], 7), path: `${TEST_JSON_PATH(0)}.annotations[0].type` },
  { name: 'results that are null', report: edited([...TEST_PATH(0), 'results'], null), path: `${TEST_JSON_PATH(0)}.results` },
  { name: 'an error message that is an object', report: edited([...RESULT_PATH(1), 'errors', 0, 'message'], { text: HOSTILE_MARKER }), path: `${RESULT_JSON_PATH(1)}.errors[0].message` },
];

for (const hostile of WRONG_TYPES) {
  test(`a report with ${hostile.name} is refused with suite-report-invalid at ${hostile.path}`, { criterion: 'AC-SPEC-35-09' }, () => {
    assertRefusedAt(hostile.report(), 'suite-report-invalid', hostile.path);
  });
}

const UNKNOWN_STATUSES: readonly HostileCase[] = [
  { name: 'a result status Playwright does not have', report: edited([...RESULT_PATH(0), 'status'], `exploded-${HOSTILE_MARKER}`), path: `${RESULT_JSON_PATH(0)}.status` },
  { name: 'a result status in another case', report: edited([...RESULT_PATH(0), 'status'], 'Passed'), path: `${RESULT_JSON_PATH(0)}.status` },
  { name: 'a test status Playwright does not have', report: edited([...TEST_PATH(0), 'status'], `weird-${HOSTILE_MARKER}`), path: `${TEST_JSON_PATH(0)}.status` },
  // With --retries=0 a test cannot be flaky, so a report that says one was is not to be believed.
  { name: 'a test claiming to be flaky', report: edited([...TEST_PATH(0), 'status'], 'flaky'), path: `${TEST_JSON_PATH(0)}.status` },
];

for (const hostile of UNKNOWN_STATUSES) {
  test(`a report with ${hostile.name} is refused with suite-report-invalid at ${hostile.path}`, { criterion: 'AC-SPEC-35-09' }, () => {
    assertRefusedAt(hostile.report(), 'suite-report-invalid', hostile.path);
  });
}

// ---- Prototype keys ---------------------------------------------------------------------------------

// JSON.parse makes "__proto__" an own key, as a hostile report file would.
const withOwnKey = (path: (string | number)[], key: string): (() => unknown) => () => {
  const report = recordedReport('each-outcome');
  const text = JSON.stringify(withValue(report, [...path, 'placeholder-key'], { polluted: HOSTILE_MARKER }));
  return JSON.parse(text.replace('"placeholder-key"', JSON.stringify(key)));
};

const PROTOTYPE_KEYS: readonly HostileCase[] = [
  { name: 'a __proto__ key at the top', report: withOwnKey([], '__proto__'), path: '$.__proto__' },
  { name: 'a __proto__ key on a test', report: withOwnKey(TEST_PATH(0), '__proto__'), path: `${TEST_JSON_PATH(0)}.__proto__` },
  { name: 'a constructor key on a spec', report: withOwnKey(specPath(0), 'constructor'), path: `${specJsonPath(0)}.constructor` },
  { name: 'a constructor key on an annotation', report: withOwnKey([...TEST_PATH(0), 'annotations', 0], 'constructor'), path: `${TEST_JSON_PATH(0)}.annotations[0].constructor` },
];

for (const hostile of PROTOTYPE_KEYS) {
  test(`a report with ${hostile.name} is refused with suite-report-invalid at ${hostile.path}, polluting nothing`, { criterion: 'AC-SPEC-35-09' }, () => {
    const report = hostile.report();
    assert.ok(JSON.stringify(report).includes(HOSTILE_MARKER), 'the hostile key was lost before decoding');
    assertRefusedAt(report, 'suite-report-invalid', hostile.path);
    assert.equal((({}) as Record<string, unknown>)['polluted'], undefined, 'Object.prototype was polluted');
  });
}

// ---- Attachment paths ---------------------------------------------------------------------------

const LEAVING_PATHS = [
  `../../${HOSTILE_MARKER}/passwd`,
  `test-results/../../${HOSTILE_MARKER}.zip`,
  `/etc/${HOSTILE_MARKER}`,
  `C:\\Windows\\${HOSTILE_MARKER}.ini`,
  `\\\\collector.example.net\\share\\${HOSTILE_MARKER}.zip`,
];

for (const leaving of LEAVING_PATHS) {
  test(`an attachment path "${leaving.replace(HOSTILE_MARKER, '…')}" that leaves the output directory is refused at its JSON path`, { criterion: 'AC-SPEC-35-09' }, () => {
    const attachment = { name: 'trace', contentType: 'application/zip', path: leaving };
    const report = withValue(recordedReport('each-outcome'), [...RESULT_PATH(1), 'attachments'], [attachment]);
    assertRefusedAt(report, 'suite-report-invalid', `${RESULT_JSON_PATH(1)}.attachments[0].path`);
  });
}

// ---- Limits -----------------------------------------------------------------------------------------

const compactBytes = (report: unknown): number => Buffer.byteLength(JSON.stringify(report), 'utf8');

test('a report over maximumReportBytes is refused with too-large', { criterion: 'AC-SPEC-35-09' }, () => {
  const report = recordedReport('each-outcome');
  const errors = refusal(report, evidenceLimits({ maximumReportBytes: Math.floor(compactBytes(report) / 2) }));
  assert.ok(errors.some((error) => error.code === 'too-large' && error.path.startsWith('$')), JSON.stringify(errors));
});

test('the same report under a maximumReportBytes twice its size decodes', { criterion: 'AC-SPEC-35-09' }, () => {
  const report = recordedReport('each-outcome');
  decodedReport(report, evidenceLimits({ maximumReportBytes: compactBytes(report) * 2 }));
});

test('a report with more tests than maximumTests is refused with too-large; one with exactly that many decodes', { criterion: 'AC-SPEC-35-09' }, () => {
  // The each-outcome report holds five tests.
  const report = recordedReport('each-outcome');
  const errors = refusal(report, evidenceLimits({ maximumTests: 4 }));
  assert.ok(errors.some((error) => error.code === 'too-large' && error.path.startsWith('$')), JSON.stringify(errors));
  decodedReport(report, evidenceLimits({ maximumTests: 5 }));
});

test('a report whose tests are counted per project is held to maximumTests across projects', { criterion: 'AC-SPEC-35-09' }, () => {
  // passing-with-criteria holds three specs, one of them run in two projects: four tests.
  const report = recordedReport('passing-with-criteria');
  const errors = refusal(report, evidenceLimits({ maximumTests: 3 }));
  assert.ok(errors.some((error) => error.code === 'too-large'), JSON.stringify(errors));
  decodedReport(report, evidenceLimits({ maximumTests: 4 }));
});

// A describe block `depth` levels deep holding one copy of the first spec.
function nestedReport(depth: number): JsonRecord {
  const report = recordedReport('each-outcome');
  const fileSuite = (report['suites'] as JsonRecord[])[0];
  const describe = (fileSuite?.['suites'] as JsonRecord[])[0];
  assert.ok(fileSuite !== undefined && describe !== undefined);
  const spec = (describe['specs'] as JsonRecord[])[0];
  let innermost: JsonRecord = { title: `level ${depth}`, file: 'checkout.spec.ts', line: 3, column: 6, specs: [spec] };
  for (let level = depth - 1; level >= 1; level--) {
    innermost = { title: `level ${level}`, file: 'checkout.spec.ts', line: 3, column: 6, specs: [], suites: [innermost] };
  }
  fileSuite['suites'] = [innermost];
  return report;
}

test('describe blocks nested 5 deep decode', { criterion: 'AC-SPEC-35-09' }, () => {
  decodedReport(nestedReport(5));
});

test('describe blocks nested 500 deep are refused with too-large, inside the suites', { criterion: 'AC-SPEC-35-09' }, () => {
  const errors = refusal(nestedReport(500));
  assert.ok(errors.some((error) => error.code === 'too-large' && error.path.startsWith('$.suites[0]')), JSON.stringify(errors).slice(0, 400));
});

// ---- Nothing echoed ----------------------------------------------------------------------------------

test('no refusal of a hostile report echoes a value from it', { criterion: 'AC-SPEC-35-09' }, () => {
  const hostile = [...WRONG_TYPES, ...UNKNOWN_STATUSES, ...PROTOTYPE_KEYS].map((entry) => entry.report());
  const leaving = LEAVING_PATHS.map((path) =>
    withValue(recordedReport('each-outcome'), [...RESULT_PATH(1), 'attachments'], [{ name: 'trace', contentType: 'application/zip', path }]));
  const carrying = [...hostile, ...leaving].filter((report) => JSON.stringify(report).includes(HOSTILE_MARKER));
  assert.ok(carrying.length >= 15, 'enough cases carry the marker for the check to mean something');
  for (const report of carrying) {
    const decoded = decodeReport(report);
    assert.equal(decoded.ok, false);
    assert.ok(!JSON.stringify(decoded).includes(HOSTILE_MARKER), `a refusal echoed its value: ${JSON.stringify(decoded)}`);
  }
});
