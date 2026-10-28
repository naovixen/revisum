// evidenceResult maps a decoded Playwright report into a run result: one entry per test and
// project, with its file, title path, project, outcome, criterion ids and finding ids. Statuses map
// one to one; a failed or timed-out test becomes a fail finding; an interrupted test, or a suite
// exit code that disagrees with the outcomes, makes the run Errored. Criterion ids come only from
// annotations of type "criterion", linked by the suite; one that is not a valid id is dropped and
// raised as spec-ambiguous. Every evidence result is labelled mode 'evidence' with the 'host'
// guarantee level and says which guarantees hold and which are lost.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EACH_OUTCOME, INTERRUPTED_SPEC, declaredCheckoutSuite, evidenceRun, recordedReport, refusal, reviewCodes, specJsonPath, specPath,
  testTitled, testsOf, withoutSpec,
} from './evidence-examples.ts';
import { withValue } from './plan-examples.ts';
import { OPEN_ORDERS, planOf, runPlan } from './run-value-examples.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---- Outcomes and the run's state ----------------------------------------------------------------

test('a report with one test of each outcome gives five tests, each with its own outcome', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(recordedReport('each-outcome'));
  assert.equal(testsOf(result).length, EACH_OUTCOME.length);
  for (const expected of EACH_OUTCOME) {
    assert.equal(testTitled(result, expected.title).outcome, expected.outcome, `${expected.title} (${expected.status})`);
  }
});

test('each test keeps its file, its describe and test titles, and its project', { criterion: 'AC-SPEC-35-11' }, () => {
  const entry = testTitled(evidenceRun(recordedReport('each-outcome')), 'shows the order total');
  assert.equal(entry.file, 'checkout.spec.ts');
  assert.equal(entry.project, 'chromium');
  assert.equal(entry.titlePath.at(-1), 'shows the order total');
  assert.ok(entry.titlePath.some((title) => title === 'Checkout'), `the describe title is missing: ${JSON.stringify(entry.titlePath)}`);
});

test('a run with an interrupted test ends Errored, whatever else passed or failed', { criterion: 'AC-SPEC-35-11' }, () => {
  assert.equal(evidenceRun(recordedReport('each-outcome')).state, 'Errored');
});

test('the same run without its interrupted test ends Failed', { criterion: 'AC-SPEC-35-11' }, () => {
  // The counter-example: the interrupted test alone made the run above Errored.
  assert.equal(evidenceRun(withoutSpec(recordedReport('each-outcome'), INTERRUPTED_SPEC)).state, 'Failed');
});

test('a run whose tests all passed or were skipped ends Passed', { criterion: 'AC-SPEC-35-11' }, () => {
  assert.equal(evidenceRun(recordedReport('passing-with-criteria')).state, 'Passed');
});

test('a suite exit code of 0 with a failed test makes the run Errored', { criterion: 'AC-SPEC-35-11' }, () => {
  const report = withoutSpec(recordedReport('each-outcome'), INTERRUPTED_SPEC);
  assert.equal(evidenceRun(report, { exitCode: 0 }).state, 'Errored');
  assert.equal(evidenceRun(report, { exitCode: 1 }).state, 'Failed', 'the agreeing exit code is the counter-example');
});

test('a suite exit code of 1 with every test passed makes the run Errored', { criterion: 'AC-SPEC-35-11' }, () => {
  const report = recordedReport('passing-with-criteria');
  assert.equal(evidenceRun(report, { exitCode: 1 }).state, 'Errored');
  assert.equal(evidenceRun(report, { exitCode: 0 }).state, 'Passed', 'the agreeing exit code is the counter-example');
});

test('a report claiming a flaky test is refused as suite-report-invalid, so no passing result can be made from it', { criterion: 'AC-SPEC-35-11' }, () => {
  const flaky = withValue(recordedReport('passing-with-criteria'), [...specPath(0), 'tests', 0, 'status'], 'flaky');
  const errors = refusal(flaky);
  assert.ok(errors.some((error) => error.code === 'suite-report-invalid' && error.path === `${specJsonPath(0)}.tests[0].status`), JSON.stringify(errors));
});

test('failed and timed-out tests each carry a finding; passed and skipped tests carry none', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(recordedReport('each-outcome'));
  for (const title of ['shows the order total', 'confirms the payment']) {
    assert.ok(testTitled(result, title).findingIds.length >= 1, `${title} has no finding`);
  }
  for (const title of ['adds an item to the cart', 'applies a gift card']) {
    assert.deepEqual(testTitled(result, title).findingIds, [], `${title} has a finding`);
  }
});

test('finding ids are not shared between the failed and the timed-out test', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(recordedReport('each-outcome'));
  const failed = testTitled(result, 'shows the order total').findingIds;
  const timedOut = testTitled(result, 'confirms the payment').findingIds;
  assert.deepEqual(failed.filter((id) => timedOut.includes(id)), []);
});

// ---- Test ids -----------------------------------------------------------------------------------

test('each test id is a sha256, the same for the same test in two results', { criterion: 'AC-SPEC-35-11' }, () => {
  const first = testsOf(evidenceRun(recordedReport('each-outcome'))).map((entry) => entry.id);
  const second = testsOf(evidenceRun(recordedReport('each-outcome'))).map((entry) => entry.id);
  for (const id of first) assert.match(id, SHA256_HEX);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, 'two tests share an id');
});

test('the same test run in two projects gets two ids', { criterion: 'AC-SPEC-35-11' }, () => {
  const result = evidenceRun(recordedReport('passing-with-criteria'));
  assert.notEqual(testTitled(result, 'pays with a saved card', 'chromium').id, testTitled(result, 'pays with a saved card', 'firefox').id);
});

test('renaming a test, or moving it to another file, changes its id', { criterion: 'AC-SPEC-35-11' }, () => {
  const original = testTitled(evidenceRun(recordedReport('each-outcome')), 'adds an item to the cart').id;
  const renamed = withValue(recordedReport('each-outcome'), [...specPath(0), 'title'], 'adds two items to the cart');
  const moved = withValue(recordedReport('each-outcome'), [...specPath(0), 'file'], 'basket.spec.ts');
  assert.notEqual(testTitled(evidenceRun(renamed), 'adds two items to the cart').id, original);
  assert.notEqual(testTitled(evidenceRun(moved), 'adds an item to the cart').id, original);
});

// ---- Mode and guarantee statement -----------------------------------------------------------------

const EVIDENCE_HOLDS = ['egress-enforced', 'no-ambient-credentials', 'pii-masked', 'secrets-redacted'];
const EVIDENCE_LOSES = ['actions-guarded', 'observable-checks', 'plan-closed', 'replay-identical', 'semantic-locators'];
const EVERY_GUARANTEE = [...EVIDENCE_HOLDS, ...EVIDENCE_LOSES].sort();

const sorted = (values: readonly string[]): string[] => [...values].sort();

test('an evidence result is labelled mode evidence at the host guarantee level', { criterion: 'AC-SPEC-35-16' }, () => {
  const result = evidenceRun(recordedReport('passing-with-criteria'));
  assert.equal(result.mode, 'evidence');
  assert.equal(result.guarantees.level, 'host');
});

test('an evidence result\'s statement holds egress, credentials, secrets and masking, and loses the rest to evidence mode', { criterion: 'AC-SPEC-35-16' }, () => {
  const { guarantees } = evidenceRun(recordedReport('passing-with-criteria'));
  assert.deepEqual(sorted(guarantees.holds), EVIDENCE_HOLDS);
  assert.deepEqual(
    [...guarantees.lost].map((entry) => ({ guarantee: entry.guarantee, because: entry.because })).sort((left, right) => (left.guarantee < right.guarantee ? -1 : 1)),
    EVIDENCE_LOSES.map((guarantee) => ({ guarantee, because: 'evidence-mode' })),
  );
});

test('with keepSuiteScreenshots set, pii-masked moves from held to lost', { criterion: 'AC-SPEC-35-16' }, () => {
  const { guarantees } = evidenceRun(recordedReport('passing-with-criteria'), { suite: declaredCheckoutSuite({ keepSuiteScreenshots: true }) });
  assert.ok(!guarantees.holds.includes('pii-masked'), 'pii-masked still holds with unmasked suite screenshots kept');
  assert.ok(guarantees.lost.some((entry) => entry.guarantee === 'pii-masked'), 'pii-masked is not listed as lost');
});

test('every guarantee is listed exactly once, as held or as lost', { criterion: 'AC-SPEC-35-16' }, () => {
  for (const keepSuiteScreenshots of [false, true]) {
    const { guarantees } = evidenceRun(recordedReport('each-outcome'), { suite: declaredCheckoutSuite({ keepSuiteScreenshots }) });
    assert.deepEqual(sorted([...guarantees.holds, ...guarantees.lost.map((entry) => entry.guarantee)]), EVERY_GUARANTEE);
  }
});

test('the guarantee statement is the same whether the suite passed or failed, and for either pass', { criterion: 'AC-SPEC-35-16' }, () => {
  // Metamorphic: what Revisum can vouch for depends on the mode, never on what the tests found.
  const statements = [
    evidenceRun(recordedReport('passing-with-criteria')),
    evidenceRun(recordedReport('each-outcome')),
    evidenceRun(recordedReport('passing-with-criteria'), { pass: 'proposal' }),
  ].map((result) => JSON.stringify({ level: result.guarantees.level, holds: sorted(result.guarantees.holds), lost: sorted(result.guarantees.lost.map((entry) => `${entry.guarantee}:${entry.because}`)) }));
  assert.equal(new Set(statements).size, 1, statements.join('\n'));
});

test('a plan run is labelled mode plan, never evidence', { criterion: 'AC-SPEC-35-16' }, async () => {
  // The counter-example: the label comes from the route the run took.
  const { result } = await runPlan(planOf([OPEN_ORDERS]));
  assert.equal(result.mode, 'plan');
});

// ---- Criterion ids linked by the suite ---------------------------------------------------------------

test('a test\'s criterion annotations become its criterion ids; other annotation types do not', { criterion: 'AC-SPEC-35-18' }, () => {
  const result = evidenceRun(recordedReport('passing-with-criteria'));
  for (const project of ['chromium', 'firefox']) {
    assert.deepEqual(sorted(testTitled(result, 'pays with a saved card', project).criterionIds), ['orders.card-masked', 'orders.saved-card'], project);
  }
  assert.deepEqual(testTitled(result, 'exports orders').criterionIds, []);
});

test('a failed test keeps the criterion id its annotation links', { criterion: 'AC-SPEC-35-18' }, () => {
  assert.deepEqual(testTitled(evidenceRun(recordedReport('each-outcome')), 'shows the order total').criterionIds, ['checkout.total-shown']);
});

test('criterion ids from annotations are labelled "linked by the suite"', { criterion: 'AC-SPEC-35-18' }, () => {
  assert.ok(JSON.stringify(evidenceRun(recordedReport('passing-with-criteria'))).includes('linked by the suite'));
});

test('an annotation whose description is not a valid criterion id is dropped and raises spec-ambiguous', { criterion: 'AC-SPEC-35-18' }, () => {
  const result = evidenceRun(recordedReport('passing-with-criteria'));
  assert.deepEqual(testTitled(result, 'lists past orders').criterionIds, []);
  assert.ok(reviewCodes(result).includes('spec-ambiguous'), JSON.stringify(result.reviewItems));
  assert.ok(!JSON.stringify(result).includes('onerror'), 'the invalid description was kept in the result');
});

test('a report whose criterion annotations are all valid raises no spec-ambiguous item', { criterion: 'AC-SPEC-35-18' }, () => {
  // The counter-example: the item above comes from the invalid descriptions.
  assert.ok(!reviewCodes(evidenceRun(recordedReport('each-outcome'))).includes('spec-ambiguous'));
});

test('each invalid kind of description is dropped: empty, spaced, too long, or holding markup', { criterion: 'AC-SPEC-35-18' }, () => {
  // The each-outcome report's annotations are otherwise all valid, so any item comes from this one.
  for (const description of ['', 'has spaces', 'x'.repeat(129), '<b>orders</b>', '-starts-with-a-dash']) {
    const report = withValue(recordedReport('each-outcome'), [...specPath(0), 'tests', 0, 'annotations'], [{ type: 'criterion', description }]);
    const result = evidenceRun(report);
    assert.deepEqual(testTitled(result, 'adds an item to the cart').criterionIds, [], JSON.stringify(description));
    assert.ok(reviewCodes(result).includes('spec-ambiguous'), JSON.stringify(description));
  }
});
