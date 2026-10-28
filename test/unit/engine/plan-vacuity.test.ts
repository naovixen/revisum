// A plan must check something, and say which acceptance criterion each check serves. A plan with
// no assertion, with an empty assertion, or with an assertion that carries no criterion id would
// pass without proving anything, so the parser rejects it as vacuous.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REMOVE, accountClosurePlan, defaultParser, signupPlan, stepsOf, withValue, type JsonRecord,
} from './plan-examples.ts';

const parsePlan = defaultParser();
const ASSERTION_TYPES = ['expect', 'expectPage'];

// The plan is rejected, and every problem reported is a vacuous one under `pathPrefix`. The spec
// fixes the code; the exact path inside the step is left to the parser.
function assertRejectedAsVacuous(input: unknown, pathPrefix: string): void {
  const parsed = parsePlan(input);
  assert.equal(parsed.ok, false, 'the plan was accepted');
  if (parsed.ok) return;
  assert.ok(parsed.error.length > 0, 'a rejection names at least one problem');
  for (const error of parsed.error) {
    assert.equal(error.code, 'vacuous', `expected only vacuous, got ${JSON.stringify(parsed.error)}`);
    assert.ok(error.path.startsWith(pathPrefix), `expected a path under ${pathPrefix}, got ${error.path}`);
  }
}

const assertAccepted = (input: unknown): void => {
  const parsed = parsePlan(input);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
};

const withoutAssertions = (plan: JsonRecord): JsonRecord =>
  ({ ...plan, steps: stepsOf(plan).filter((step) => !ASSERTION_TYPES.includes(String(step['type']))) });

// ---- No assertion at all ------------------------------------------------------------------------

test('rejects a plan with no assertion as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  const plan = withoutAssertions(signupPlan());
  assert.ok(stepsOf(plan).length > 0, 'the plan still has steps, just no checks');
  assertRejectedAsVacuous(plan, '$');
});

test('rejects a plan whose only steps act and capture, with an accessibility report, as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  const plan = { ...signupPlan(), steps: [
    { type: 'navigate', url: '/' },
    { type: 'click', locator: { by: 'role', role: 'button', name: 'Create account' } },
    { type: 'a11yAudit', mode: 'report' },
    { type: 'capture', name: 'after-click' },
  ] };
  assertRejectedAsVacuous(plan, '$');
});

test('accepts the same plan once it keeps a single assertion with a criterion id', { criterion: 'AC-SPEC-01-04' }, () => {
  const steps = stepsOf(signupPlan());
  const kept = steps.filter((step, index) => !ASSERTION_TYPES.includes(String(step['type'])) || index === 9);
  assert.equal(kept.filter((step) => ASSERTION_TYPES.includes(String(step['type']))).length, 1);
  assertAccepted({ ...signupPlan(), steps: kept });
});

// ---- An empty assertion -------------------------------------------------------------------------

test('rejects an element assertion that is an empty object as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(signupPlan(), ['steps', 1, 'assert'], {}), '$.steps[1]');
});

test('rejects a page assertion that is an empty object as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(signupPlan(), ['steps', 2, 'assert'], {}), '$.steps[2]');
});

test('rejects an element assertion that compares against empty text as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(signupPlan(), ['steps', 9, 'assert', 'value'], ''), '$.steps[9]');
});

test('rejects an empty assertion inside a frame as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(accountClosurePlan(), ['steps', 3, 'steps', 1, 'assert'], {}), '$.steps[3].steps[1]');
});

// ---- An assertion with no criterion id ----------------------------------------------------------

test('rejects an element assertion without a criterion id as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(signupPlan(), ['steps', 1, 'criterionId'], REMOVE), '$.steps[1]');
});

test('rejects a page assertion without a criterion id as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(signupPlan(), ['steps', 2, 'criterionId'], REMOVE), '$.steps[2]');
});

test('rejects an absent-element assertion without a criterion id as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(accountClosurePlan(), ['steps', 6, 'criterionId'], REMOVE), '$.steps[6]');
});

test('rejects an assertion inside a frame without a criterion id as vacuous', { criterion: 'AC-SPEC-01-04' }, () => {
  assertRejectedAsVacuous(withValue(accountClosurePlan(), ['steps', 3, 'steps', 1, 'criterionId'], REMOVE), '$.steps[3].steps[1]');
});

test('one assertion without a criterion id is enough to reject a plan whose other assertions have one', { criterion: 'AC-SPEC-01-04' }, () => {
  const plan = withValue(signupPlan(), ['steps', 10, 'criterionId'], REMOVE);
  const traced = stepsOf(plan).filter((step) => ASSERTION_TYPES.includes(String(step['type'])) && 'criterionId' in step);
  assert.equal(traced.length, 4, 'four of the five assertions are still traced');
  assertRejectedAsVacuous(plan, '$.steps[10]');
});

// ---- Counter-examples: the same plans, traced and non-empty, are accepted -------------------------

test('accepts the sign-up and account-closure plans, whose every assertion is non-empty and traced', { criterion: 'AC-SPEC-01-04' }, () => {
  for (const plan of [signupPlan(), accountClosurePlan()]) {
    const assertions = stepsOf(plan).flatMap((step) => [step, ...((step['steps'] as JsonRecord[] | undefined) ?? [])])
      .filter((step) => ASSERTION_TYPES.includes(String(step['type'])));
    assert.ok(assertions.length > 0 && assertions.every((step) => typeof step['criterionId'] === 'string'));
    assertAccepted(plan);
  }
});

test('the criterion id survives parsing on every assertion', { criterion: 'AC-SPEC-01-04' }, () => {
  const parsed = parsePlan(signupPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const criterionIds = parsed.value.steps.flatMap((step) => ('criterionId' in step ? [step.criterionId] : []));
  assert.deepEqual(criterionIds, ['signup.heading-shown', 'signup.page-titled', 'signup.email-kept', 'signup.welcome-shown', 'signup.address-echoed']);
});
