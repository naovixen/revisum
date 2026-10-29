// Plan 1.3's unsafe constructs have a readable text form (SPEC-28, "Readable syntax for plan 1.3"),
// so readablePlanText no longer refuses any plan: for a plan using any unsafe feature, all six at
// once, and every unsafe golden plan, it gives exactly writePlanText's text. no-readable-form stays
// in the codes for a future construct that reaches the language before its readable form does.
// The closed golden plans keep their text too.
// See docs/specs/SPEC-36-unsafe-plan-features.md (Build notes) and docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readablePlanText, writePlanText } from '@revisum/engine';
import { GOLDEN } from '../../support/repository.ts';
import { goldenPlan, goldenPlanNames } from './plan-examples.ts';
import { acceptedBy, parserEnabling } from './unsafe-feature-examples.ts';
import { ALL_FEATURES_PLAN, FEATURES, FEATURE_EXAMPLES, unsafePlan } from './unsafe-feature-steps.ts';

const parseAll = parserEnabling(FEATURES);

for (const example of FEATURE_EXAMPLES) {
  test(`readablePlanText writes a plan using ${example.feature} as exactly writePlanText's text`, { criterion: 'AC-SPEC-36-16' }, () => {
    const plan = acceptedBy(parseAll, unsafePlan(example.steps));
    assert.deepEqual(readablePlanText(plan), { ok: true, value: writePlanText(plan) });
  });
}

test('readablePlanText writes the plan using all six features as exactly writePlanText\'s text', { criterion: 'AC-SPEC-36-16' }, () => {
  const plan = acceptedBy(parseAll, ALL_FEATURES_PLAN());
  assert.deepEqual(readablePlanText(plan), { ok: true, value: writePlanText(plan) });
});

for (const feature of FEATURES) {
  test(`readablePlanText writes the ${feature} golden plan as exactly writePlanText's text`, { criterion: 'AC-SPEC-36-16' }, () => {
    const plan = acceptedBy(parseAll, JSON.parse(readFileSync(join(GOLDEN, 'unsafe-plans', `${feature}.json`), 'utf8')));
    assert.deepEqual(readablePlanText(plan), { ok: true, value: writePlanText(plan) });
  });
}

// Counter-example: a closed plan, parsed under the same project, gets the same text as before, so
// the unsafe plans above are not written by a path that only closed plans take.
test('readablePlanText gives exactly writePlanText\'s text for every closed golden plan', { criterion: 'AC-SPEC-36-16' }, () => {
  for (const name of goldenPlanNames()) {
    const plan = acceptedBy(parseAll, goldenPlan(name));
    assert.deepEqual(readablePlanText(plan), { ok: true, value: writePlanText(plan) }, name);
  }
});
