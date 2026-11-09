// The 1.3 golden plans: test/golden/unsafe-plans/ holds one plan per unsafe feature, named after it.
// Each parses against the shared unsafe project (unsafe-feature-steps.ts) and uses exactly its own
// feature, and each is refused with unsafe_feature_disabled once that feature is off. test/golden/plans/
// stays 1.1 and 1.2.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GOLDEN } from '../../../../support/repository/RepositoryRoot.ts';
import { acceptedBy, allBut, disabledPaths, errorsOf, featuresOf, parserEnabling } from './examples/LostByFeature.ts';
import { CURRENT_VERSION, FEATURES, type JsonRecord } from './examples/UnsafePlan.ts';

const FOLDER = join(GOLDEN, 'unsafe-plans');
const unsafeGoldenPlan = (feature: string): JsonRecord => JSON.parse(readFileSync(join(FOLDER, `${feature}.json`), 'utf8'));

test('golden/unsafe-plans/ holds one plan per feature, and nothing else', () => {
  assert.deepEqual(readdirSync(FOLDER).sort(), FEATURES.map((feature) => `${feature}.json`).sort());
});

for (const feature of FEATURES) {
  test(`the ${feature} golden plan declares 1.3, parses against the unsafe project and uses exactly ${feature}`, () => {
    const raw = unsafeGoldenPlan(feature);
    assert.equal(raw['version'], CURRENT_VERSION);
    assert.deepEqual(featuresOf(acceptedBy(parserEnabling(FEATURES), raw)), [feature]);
  });

  test(`the ${feature} golden plan is refused with unsafe_feature_disabled once ${feature} is off`, () => {
    const paths = disabledPaths(errorsOf(parserEnabling(allBut(feature)), unsafeGoldenPlan(feature)));
    assert.ok(paths.length >= 1, `${feature}: no unsafe_feature_disabled error`);
  });
}
