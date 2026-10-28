// An element assertion that compares text must say what it compares against: no value is a
// missing field, and an empty value is vacuous, since it would pass on any element.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planParser } from '@revisum/engine';
import { makeProject, signupPlan } from '../../support/signup-harness.ts';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGETS = ['playwright-chromium'];
const parsePlan = planParser(makeProject(ORIGIN));
const TEXT_VALUE_KINDS = ['textEquals', 'textContains', 'valueEquals', 'valueContains'] as const;

type RawStep = Readonly<Record<string, unknown>>;

// The sign-up plan with its first value-carrying expect step's assertion replaced. Other fields
// of the assertion are kept, so the plan stays valid apart from the change under test.
function planWithAssertion(change: (assertion: Record<string, unknown>) => void): { readonly input: unknown; readonly path: string } {
  const plan: { steps: RawStep[] } = structuredClone(signupPlan(TARGETS));
  const index = plan.steps.findIndex((step) => {
    const assertion = step['assert'];
    return step['type'] === 'expect' && typeof assertion === 'object' && assertion !== null && 'value' in assertion;
  });
  assert.ok(index >= 0, 'the sign-up plan has an expect step with a value');
  const step = plan.steps[index] ?? {};
  const assertion: Record<string, unknown> = { ...(step['assert'] as Record<string, unknown>) };
  change(assertion);
  plan.steps[index] = { ...step, assert: assertion };
  return { input: plan, path: `$.steps[${index}].assert.value` };
}

test('the unchanged sign-up plan parses, so each rejection below comes from the assertion alone', { criterion: 'AC-SPEC-27-07' }, () => {
  const parsed = parsePlan(signupPlan(TARGETS));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

for (const kind of TEXT_VALUE_KINDS) {
  test(`rejects a ${kind} assertion with no value as missing_field`, { criterion: 'AC-SPEC-27-07' }, () => {
    const { input, path } = planWithAssertion((assertion) => {
      assertion['kind'] = kind;
      delete assertion['value'];
    });
    assert.deepEqual(parsePlan(input), { ok: false, error: [{ code: 'missing_field', path }] });
  });

  test(`rejects a ${kind} assertion with an empty value as vacuous`, { criterion: 'AC-SPEC-27-07' }, () => {
    const { input, path } = planWithAssertion((assertion) => {
      assertion['kind'] = kind;
      assertion['value'] = '';
    });
    assert.deepEqual(parsePlan(input), { ok: false, error: [{ code: 'vacuous', path }] });
  });

  // The counter-example: the same assertion with a non-empty value is accepted.
  test(`accepts a ${kind} assertion with a non-empty value`, { criterion: 'AC-SPEC-27-07' }, () => {
    const { input } = planWithAssertion((assertion) => {
      assertion['kind'] = kind;
      assertion['value'] = 'ada@example.test';
    });
    const parsed = parsePlan(input);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });
}
