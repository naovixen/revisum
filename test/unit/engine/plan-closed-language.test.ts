// The plan language is closed at every depth: an unknown key, step type or value anywhere in a
// plan, including inside a frame step, is rejected with its error code and JSON path. Errors
// name where the problem is, never what the value was, so hostile or private text is not echoed.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRIVATE_MARKER, accountClosurePlan, defaultParser, goldenPlanNames, goldenPlan, signupPlan, withValue,
  type JsonRecord,
} from './plan-examples.ts';

const parsePlan = defaultParser();

type ClosedCase = {
  readonly name: string;
  readonly plan: () => JsonRecord;
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly code: string;
  readonly errorPath: string;
};

// Each case changes one place in a valid plan. Values that are not keys carry PRIVATE_MARKER, so
// the no-echo check below has something to look for.
const CASES: readonly ClosedCase[] = [
  // Unknown keys, from the top of the plan down into a frame's nested step.
  { name: 'an unknown top-level key', plan: signupPlan, path: ['shell'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.shell' },
  { name: 'an unknown key in the plan metadata', plan: signupPlan, path: ['meta', 'owner'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.meta.owner' },
  { name: 'an unknown key on a step', plan: signupPlan, path: ['steps', 7, 'force'], value: true, code: 'unknown_field', errorPath: '$.steps[7].force' },
  { name: 'an unknown key in a locator', plan: signupPlan, path: ['steps', 1, 'locator', 'selector'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.steps[1].locator.selector' },
  { name: 'an unknown key in an assertion', plan: signupPlan, path: ['steps', 5, 'assert', 'timeout'], value: 99, code: 'unknown_field', errorPath: '$.steps[5].assert.timeout' },
  { name: 'an unknown key on a hover step', plan: accountClosurePlan, path: ['steps', 1, 'delay'], value: 500, code: 'unknown_field', errorPath: '$.steps[1].delay' },
  { name: 'an unknown key on a select step', plan: accountClosurePlan, path: ['steps', 2, 'index'], value: 3, code: 'unknown_field', errorPath: '$.steps[2].index' },
  { name: 'an unknown key on a frame step', plan: accountClosurePlan, path: ['steps', 3, 'url'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.steps[3].url' },
  { name: 'an unknown key on a step inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 0, 'force'], value: true, code: 'unknown_field', errorPath: '$.steps[3].steps[0].force' },
  { name: 'an unknown key in a locator inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 1, 'locator', 'xpath'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.steps[3].steps[1].locator.xpath' },
  { name: 'an unknown key in an assertion inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 1, 'assert', 'retries'], value: 5, code: 'unknown_field', errorPath: '$.steps[3].steps[1].assert.retries' },
  { name: 'an unknown key on a dialog step', plan: accountClosurePlan, path: ['steps', 5, 'promptText'], value: PRIVATE_MARKER, code: 'unknown_field', errorPath: '$.steps[5].promptText' },

  // Unknown step types, at the top and inside a frame.
  { name: 'an unknown step type', plan: signupPlan, path: ['steps', 6, 'type'], value: PRIVATE_MARKER, code: 'unknown_step', errorPath: '$.steps[6].type' },
  { name: 'an unknown step type inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 0, 'type'], value: PRIVATE_MARKER, code: 'unknown_step', errorPath: '$.steps[3].steps[0].type' },

  // Unknown values of closed sets.
  { name: 'an unknown locator kind', plan: signupPlan, path: ['steps', 3, 'locator', 'by'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[3].locator.by' },
  { name: 'an unknown ARIA role', plan: signupPlan, path: ['steps', 1, 'locator', 'role'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[1].locator.role' },
  { name: 'an unknown element assertion kind', plan: signupPlan, path: ['steps', 9, 'assert', 'kind'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[9].assert.kind' },
  { name: 'a page assertion kind used on an element', plan: signupPlan, path: ['steps', 9, 'assert', 'kind'], value: 'title', code: 'unknown_value', errorPath: '$.steps[9].assert.kind' },
  { name: 'an unknown page assertion kind', plan: signupPlan, path: ['steps', 2, 'assert', 'kind'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[2].assert.kind' },
  { name: 'an unknown accessibility audit mode', plan: signupPlan, path: ['steps', 11, 'mode'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[11].mode' },
  { name: 'an unknown dialog action', plan: accountClosurePlan, path: ['steps', 5, 'action'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[5].action' },
  { name: 'a key from another locator kind on a frame\'s own locator', plan: accountClosurePlan, path: ['steps', 3, 'locator', 'role'], value: 'button', code: 'unknown_field', errorPath: '$.steps[3].locator.role' },
  { name: 'an unknown locator kind inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 0, 'locator', 'by'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[3].steps[0].locator.by' },
  { name: 'an unknown assertion kind inside a frame', plan: accountClosurePlan, path: ['steps', 3, 'steps', 1, 'assert', 'kind'], value: PRIVATE_MARKER, code: 'unknown_value', errorPath: '$.steps[3].steps[1].assert.kind' },
];

// The counter-example for every case below: each base plan parses unchanged.
for (const name of goldenPlanNames()) {
  test(`the golden plan "${name}" parses unchanged`, { criterion: 'AC-SPEC-01-03' }, () => {
    const parsed = parsePlan(goldenPlan(name));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });
}

for (const closed of CASES) {
  test(`rejects ${closed.name} with ${closed.code} at ${closed.errorPath}`, { criterion: 'AC-SPEC-01-03' }, () => {
    const parsed = parsePlan(withValue(closed.plan(), closed.path, closed.value));
    assert.deepEqual(parsed, { ok: false, error: [{ code: closed.code, path: closed.errorPath }] });
  });
}

test('no rejection echoes the value that caused it', { criterion: 'AC-SPEC-01-03' }, () => {
  const withMarker = CASES.filter((closed) => closed.value === PRIVATE_MARKER);
  assert.ok(withMarker.length >= 10, 'enough cases carry the marker for the check to mean something');
  for (const closed of withMarker) {
    const parsed = parsePlan(withValue(closed.plan(), closed.path, closed.value));
    assert.equal(parsed.ok, false, closed.name);
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), `${closed.name}: the error echoed the value: ${JSON.stringify(parsed)}`);
  }
});

test('a rejection lists every problem in the plan, each with its own path', { criterion: 'AC-SPEC-01-03' }, () => {
  let plan = withValue(accountClosurePlan(), ['steps', 1, 'delay'], 500);
  plan = withValue(plan, ['steps', 3, 'steps', 0, 'type'], 'wait');
  plan = withValue(plan, ['steps', 5, 'action'], 'ignore');
  const parsed = parsePlan(plan);
  assert.equal(parsed.ok, false);
  const found = parsed.ok ? [] : [...parsed.error].map((error) => `${error.code} ${error.path}`).sort();
  assert.deepEqual(found, [
    'unknown_field $.steps[1].delay',
    'unknown_step $.steps[3].steps[0].type',
    'unknown_value $.steps[5].action',
  ]);
});
