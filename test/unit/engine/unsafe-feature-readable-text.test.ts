// Plan 1.3's unsafe constructs have no readable text form in M1: JSON is their route.
// readablePlanText is the one route to readable text that may refuse: a plan using an unsafe
// construct is refused with the text code no-readable-form and the path of a construct, rather
// than written as text that would drop or misstate it, and so the unsafe label with it. For a
// closed plan it gives exactly writePlanText's text. writePlanText itself keeps returning text.
// See docs/specs/SPEC-36-unsafe-plan-features.md (Build notes) and docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readablePlanText, writePlanText } from '@revisum/engine';
import { goldenPlan, goldenPlanNames } from './plan-examples.ts';
import { acceptedBy, parserEnabling } from './unsafe-feature-examples.ts';
import { ALL_FEATURES_PATHS, ALL_FEATURES_PLAN, FEATURES, FEATURE_EXAMPLES, unsafePlan } from './unsafe-feature-steps.ts';

const parseAll = parserEnabling(FEATURES);

for (const example of FEATURE_EXAMPLES) {
  test(`readablePlanText refuses a plan using ${example.feature} with no-readable-form at ${example.path}`, { criterion: 'AC-SPEC-36-16' }, () => {
    const outcome = readablePlanText(acceptedBy(parseAll, unsafePlan(example.steps)));
    assert.deepEqual(outcome, { ok: false, error: { code: 'no-readable-form', path: example.path } });
  });
}

test('readablePlanText refuses the plan using all six features with no-readable-form at one of its unsafe constructs', { criterion: 'AC-SPEC-36-16' }, () => {
  const outcome = readablePlanText(acceptedBy(parseAll, ALL_FEATURES_PLAN()));
  assert.equal(outcome.ok, false, 'text was written for an unsafe plan');
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'no-readable-form');
    assert.ok(ALL_FEATURES_PATHS.includes(outcome.error.path), outcome.error.path);
  }
});

// Counter-example: for a closed plan, parsed under the same project, it writes the same text as
// writePlanText, so the refusals above come from the unsafe constructs alone.
test('readablePlanText gives exactly writePlanText\'s text for every closed golden plan', { criterion: 'AC-SPEC-36-16' }, () => {
  for (const name of goldenPlanNames()) {
    const plan = acceptedBy(parseAll, goldenPlan(name));
    assert.deepEqual(readablePlanText(plan), { ok: true, value: writePlanText(plan) }, name);
  }
});
