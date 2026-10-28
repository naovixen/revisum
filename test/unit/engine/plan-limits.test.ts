// Size and frame-depth limits are checked before the parser walks a plan, so an oversized or
// deeply nested plan costs nothing to reject and cannot exhaust the parser. Such a plan gets one
// error, too_large, and none of the problems hidden inside it are reported.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planParser } from '@revisum/engine';
import { accountClosurePlan, signupPlan, stepsOf, testProject, type JsonRecord } from './plan-examples.ts';

const MAXIMUM_PLAN_BYTES = 8 * 1024;
const MAXIMUM_FRAME_DEPTH = 2;
// Built on first use, so a project that cannot be built fails each test rather than the file.
let limitedParser: ReturnType<typeof planParser> | undefined;
const parsePlan = (input: unknown): ReturnType<ReturnType<typeof planParser>> => {
  limitedParser ??= planParser(testProject({ maximumPlanBytes: MAXIMUM_PLAN_BYTES, maximumFrameDepth: MAXIMUM_FRAME_DEPTH }));
  return limitedParser(input);
};

const sizeInBytes = (input: unknown): number => new TextEncoder().encode(JSON.stringify(input)).length;

// Problems a walk would find. If any is reported, the parser walked the plan.
const HIDDEN_PROBLEMS: readonly JsonRecord[] = [
  { type: 'eval', code: 'fetch("/admin")' },
  { type: 'click', locator: { by: 'css', selector: '#submit' }, force: true },
];

const frame = (steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator: { by: 'testId', testId: 'nested-frame' }, steps });
const tracedExpect = { type: 'expect', locator: { by: 'label', label: 'Name' }, assert: { kind: 'visible' }, criterionId: 'frames.name-visible' };

// A frame step nested `depth` deep, with `innermost` as the deepest frame's steps.
function nestedFrames(depth: number, innermost: readonly unknown[]): JsonRecord {
  let step = frame(innermost);
  for (let level = 1; level < depth; level++) step = frame([step]);
  return step;
}

const planWith = (...steps: unknown[]): JsonRecord => ({ ...signupPlan(), steps: [{ type: 'navigate', url: '/' }, ...steps] });

const assertOnlyTooLarge = (input: unknown): void => {
  const parsed = parsePlan(input);
  assert.equal(parsed.ok, false, 'the plan was accepted');
  if (parsed.ok) return;
  assert.equal(parsed.error.length, 1, `expected one error, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.error[0]?.code, 'too_large');
  assert.ok(parsed.error[0]?.path.startsWith('$'), 'the path is a JSON path');
};

// ---- Size ---------------------------------------------------------------------------------------

test('rejects a plan over the size limit with too_large at the root, before walking it', { criterion: 'AC-SPEC-01-11' }, () => {
  const padding = Array.from({ length: 200 }, (_unused, index) => ({ type: 'capture', name: `padding-${index}` }));
  const plan = { ...planWith(...HIDDEN_PROBLEMS, ...padding, tracedExpect), shell: 'rm -rf /' };
  assert.ok(sizeInBytes(plan) > MAXIMUM_PLAN_BYTES);
  assert.deepEqual(parsePlan(plan), { ok: false, error: [{ code: 'too_large', path: '$' }] });
});

test('rejects one oversized text value with too_large, before walking the plan', { criterion: 'AC-SPEC-01-11' }, () => {
  const plan = planWith(...HIDDEN_PROBLEMS, { ...tracedExpect, assert: { kind: 'textEquals', value: 'x'.repeat(MAXIMUM_PLAN_BYTES) } });
  assert.deepEqual(parsePlan(plan), { ok: false, error: [{ code: 'too_large', path: '$' }] });
});

// Counter-example: a valid plan under the limit is accepted by the same parser.
test('accepts a valid plan under the size limit', { criterion: 'AC-SPEC-01-11' }, () => {
  const plan = signupPlan();
  assert.ok(sizeInBytes(plan) < MAXIMUM_PLAN_BYTES);
  const parsed = parsePlan(plan);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

// ---- Frame depth --------------------------------------------------------------------------------

test('rejects frames nested one deeper than the limit with too_large, before walking them', { criterion: 'AC-SPEC-01-11' }, () => {
  const plan = planWith(nestedFrames(MAXIMUM_FRAME_DEPTH + 1, [...HIDDEN_PROBLEMS, tracedExpect]), tracedExpect);
  assert.ok(sizeInBytes(plan) < MAXIMUM_PLAN_BYTES, 'small enough that only the depth can be the reason');
  assertOnlyTooLarge(plan);
});

test('rejects frames nested far deeper than the limit with too_large and does not crash', { criterion: 'AC-SPEC-01-11' }, () => {
  assert.doesNotThrow(() => assertOnlyTooLarge(planWith(nestedFrames(5_000, [tracedExpect]), tracedExpect)));
});

test('rejects a too-deep frame that follows valid frames', { criterion: 'AC-SPEC-01-11' }, () => {
  const plan = planWith(nestedFrames(1, [tracedExpect]), nestedFrames(MAXIMUM_FRAME_DEPTH + 1, [tracedExpect]), tracedExpect);
  assertOnlyTooLarge(plan);
});

// Counter-examples: frames at exactly the limit, side by side or nested, are accepted.
test('accepts frames nested exactly to the depth limit', { criterion: 'AC-SPEC-01-11' }, () => {
  const parsed = parsePlan(planWith(nestedFrames(MAXIMUM_FRAME_DEPTH, [tracedExpect]), tracedExpect));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test('accepts many frames side by side, since depth and not count is limited', { criterion: 'AC-SPEC-01-11' }, () => {
  const parsed = parsePlan(planWith(...Array.from({ length: MAXIMUM_FRAME_DEPTH + 3 }, () => nestedFrames(1, [tracedExpect]))));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test('the account-closure plan, with one frame, is within the depth limit', { criterion: 'AC-SPEC-01-11' }, () => {
  assert.equal(stepsOf(accountClosurePlan()).filter((step) => step['type'] === 'frame').length, 1);
  const parsed = parsePlan(accountClosurePlan());
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});
