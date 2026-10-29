// Two outcome rules for the M2 suite runner. A suite whose report holds no tests checked nothing,
// so it never ends Passed: it ends Failed with the finding code "vacuous", whatever its exit code.
// A test the suite marks as expected to fail (test.fail(), expectedStatus "failed") that does fail
// is not an ordinary failure, nor a reason to end the run Errored: it gets its own outcome,
// "expected-failure", and a review item with the same reason, so a person looks at it.
// Counter-examples: a report with a passing test ends Passed with no "vacuous" code, and the same
// failed test expected to pass is an ordinary failure.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evidenceRun, opensMergeGate, recordedReport, reviewCodes, specPath, testTitled, testsOf, withoutSpec, type JsonRecord,
} from './evidence-examples.ts';
import { withValue } from './plan-examples.ts';

// The code appears somewhere in the result as a whole value, wherever the result keeps codes.
const carriesCode = (value: unknown, code: string): boolean => JSON.stringify(value).includes(JSON.stringify(code));

// ---- No tests ------------------------------------------------------------------------------------

const EMPTY_REPORT = (): JsonRecord => withValue(withValue(recordedReport('passing-with-criteria'), ['suites'], []), ['stats'], {
  startTime: '2026-10-28T10:00:00.000Z', duration: 12.5, expected: 0, skipped: 0, unexpected: 0, flaky: 0,
});

// Playwright Test exits with 1 and "No tests found" when nothing matches, and with 0 when the
// team's config sets passWithNoTests. Neither may pass.
for (const exitCode of [1, 0]) {
  test(`a report with no tests and exit code ${exitCode} ends Failed with the code vacuous`, { criterion: 'AC-SPEC-35-11' }, () => {
    const result = evidenceRun(EMPTY_REPORT(), { exitCode });
    assert.deepEqual(testsOf(result), []);
    assert.equal(result.state, 'Failed');
    assert.ok(carriesCode(result, 'vacuous'), `the result does not say it is vacuous: ${JSON.stringify(result)}`);
  });
}

test('a report with no tests never opens the merge gate', { criterion: 'AC-SPEC-35-11' }, () => {
  assert.equal(opensMergeGate(evidenceRun(EMPTY_REPORT(), { exitCode: 0 })), false);
});

test('counter-example: a report with passing tests ends Passed and is not called vacuous', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(recordedReport('passing-with-criteria'));
  assert.equal(result.state, 'Passed');
  assert.equal(carriesCode(result, 'vacuous'), false);
});

// ---- Expected failures ------------------------------------------------------------------------------

const FAILED_SPEC = 1;
const FAILED_TITLE = 'shows the order total';
const INTERRUPTED_SPEC = 4;

// The each-outcome report with only its passing and failing tests, the failing one marked by the
// suite as expected to fail: Playwright then calls the test "expected" and exits with 0.
function expectedFailureReport(): JsonRecord {
  const base = withoutSpec(withoutSpec(withoutSpec(recordedReport('each-outcome'), INTERRUPTED_SPEC), 3), 2);
  const testPath = [...specPath(FAILED_SPEC), 'tests', 0];
  const marked = withValue(withValue(base, [...testPath, 'expectedStatus'], 'failed'), [...testPath, 'status'], 'expected');
  return withValue(withValue(marked, [...specPath(FAILED_SPEC), 'ok'], true), [...testPath, 'annotations'], [{ type: 'fail' }]);
}

test('a failed test the suite expected to fail gets the outcome expected-failure', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(expectedFailureReport(), { exitCode: 0 });
  assert.equal(testTitled(result, FAILED_TITLE).outcome, 'expected-failure');
  assert.equal(testTitled(result, 'adds an item to the cart').outcome, 'passed');
});

test('an expected failure raises a review item with the reason expected-failure', { criterion: 'AC-SPEC-35-11' }, () => {
  const codes = reviewCodes(evidenceRun(expectedFailureReport(), { exitCode: 0 }));
  assert.equal(codes.filter((code) => code === 'expected-failure').length, 1, JSON.stringify(codes));
});

test('an expected failure with Playwright\'s exit code 0 does not end the run Errored', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(expectedFailureReport(), { exitCode: 0 });
  assert.notEqual(result.state, 'Errored');
  assert.notEqual(result.evidence?.exitCodeMismatch, true);
});

test('a run with an expected failure does not open the merge gate, since a person must look at it', { criterion: 'AC-SPEC-35-11' }, () => {
  assert.equal(opensMergeGate(evidenceRun(expectedFailureReport(), { exitCode: 0 })), false);
});

test('counter-example: the same failed test expected to pass is an ordinary failure, with no expected-failure item', { criterion: 'AC-SPEC-35-11' }, () => {
  const report = withoutSpec(withoutSpec(withoutSpec(recordedReport('each-outcome'), INTERRUPTED_SPEC), 3), 2);
  const result = evidenceRun(report, { exitCode: 1 });
  assert.equal(testTitled(result, FAILED_TITLE).outcome, 'failed');
  assert.equal(result.state, 'Failed');
  assert.ok(!reviewCodes(result).includes('expected-failure'), JSON.stringify(reviewCodes(result)));
});
