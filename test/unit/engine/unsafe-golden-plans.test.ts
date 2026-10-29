// The 1.3 golden plans: golden/unsafe-plans/ holds one plan per unsafe feature, named after it.
// Each parses against the shared unsafe project (unsafe-feature-steps.ts) and uses exactly its own
// feature, and each is refused with unsafe_feature_disabled once that feature is off. golden/plans/
// stays 1.1 and 1.2.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GOLDEN } from '../../support/repository.ts';
import { acceptedBy, allBut, disabledPaths, errorsOf, featuresOf, parserEnabling } from './unsafe-feature-examples.ts';
import { FEATURES, UNSAFE_VERSION, type JsonRecord } from './unsafe-feature-steps.ts';

const FOLDER = join(GOLDEN, 'unsafe-plans');
const unsafeGoldenPlan = (feature: string): JsonRecord => JSON.parse(readFileSync(join(FOLDER, `${feature}.json`), 'utf8'));

test('golden/unsafe-plans/ holds one plan per feature, and nothing else', { criterion: 'AC-SPEC-36-16' }, () => {
  assert.deepEqual(readdirSync(FOLDER).sort(), FEATURES.map((feature) => `${feature}.json`).sort());
});

for (const feature of FEATURES) {
  test(`the ${feature} golden plan declares 1.3, parses against the unsafe project and uses exactly ${feature}`, { criterion: 'AC-SPEC-36-16' }, () => {
    const raw = unsafeGoldenPlan(feature);
    assert.equal(raw['version'], UNSAFE_VERSION);
    assert.deepEqual(featuresOf(acceptedBy(parserEnabling(FEATURES), raw)), [feature]);
  });

  test(`the ${feature} golden plan is refused with unsafe_feature_disabled once ${feature} is off`, { criterion: 'AC-SPEC-36-01' }, () => {
    const paths = disabledPaths(errorsOf(parserEnabling(allBut(feature)), unsafeGoldenPlan(feature)));
    assert.ok(paths.length >= 1, `${feature}: no unsafe_feature_disabled error`);
  });
}
