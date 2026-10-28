// Plans written in version 1 of the language, before assertions carried criterion ids, still
// work for a time, but only through migratePlan: the author supplies a criterion id for every
// assertion, and the migration adds it and changes nothing else. A missing id fails, so nothing
// migrates silently.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migratePlan, type CriterionMapping } from '@revisum/engine';
import { signupPlan as seededSignupPlan } from '../../support/signup-harness.ts';
import {
  CURRENT_VERSION, TARGET_ID, criterionMapping, defaultParser, goldenPlan, legacyPlan, migrationExampleNames,
  stepsOf, type JsonRecord,
} from './plan-examples.ts';

const parsePlan = defaultParser();
const ASSERTION_TYPES = ['expect', 'expectPage'];

// The mapping file holds plain strings; migratePlan takes branded criterion ids. The cast is the
// test standing in for the author, who writes the mapping by hand.
const mappingFor = (name: string): CriterionMapping => criterionMapping(name) as CriterionMapping;

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const assertionPaths = (plan: JsonRecord): string[] =>
  stepsOf(plan).flatMap((step, index) => (ASSERTION_TYPES.includes(String(step['type'])) ? [`$.steps[${index}]`] : []));

test('there are migration examples, and each has a stored current-language golden plan', { criterion: 'AC-SPEC-01-08' }, () => {
  const names = migrationExampleNames();
  assert.deepEqual(names, ['consent', 'environment', 'signup']);
  for (const name of names) assert.equal(goldenPlan(name)['version'], CURRENT_VERSION);
});

test('the golden sign-up plan is the shared sign-up plan the other suites run', { criterion: 'AC-SPEC-01-08' }, () => {
  assert.deepEqual(goldenPlan('signup'), seededSignupPlan([TARGET_ID]));
});

test('every mapping names exactly the assertions of its example', { criterion: 'AC-SPEC-01-08' }, () => {
  for (const name of migrationExampleNames()) {
    assert.deepEqual(Object.keys(criterionMapping(name)).sort(), assertionPaths(legacyPlan(name)).sort(), name);
  }
});

for (const name of migrationExampleNames()) {
  test(`${name}: migrates to the stored current-language golden plan`, { criterion: 'AC-SPEC-01-08' }, () => {
    const migrated = migratePlan(legacyPlan(name), mappingFor(name));
    assert.ok(migrated.ok, JSON.stringify(migrated));
    assert.deepEqual(migrated.value, goldenPlan(name));
  });

  test(`${name}: the migrated plan parses as the current language`, { criterion: 'AC-SPEC-01-08' }, () => {
    const migrated = migratePlan(legacyPlan(name), mappingFor(name));
    assert.ok(migrated.ok, JSON.stringify(migrated));
    assert.equal(migrated.value.version, CURRENT_VERSION);
    const parsed = parsePlan(migrated.value);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });

  test(`${name}: every step is unchanged apart from the added criterion id`, { criterion: 'AC-SPEC-01-08' }, () => {
    const original = legacyPlan(name);
    const mapping = criterionMapping(name);
    const migrated = migratePlan(original, mappingFor(name));
    assert.ok(migrated.ok, JSON.stringify(migrated));
    const after = migrated.value as unknown as JsonRecord;
    assert.deepEqual(after['meta'], original['meta'], 'metadata unchanged');
    assert.deepEqual(after['targets'], original['targets'], 'targets unchanged');
    const before = stepsOf(original);
    const migratedSteps = stepsOf(after);
    assert.equal(migratedSteps.length, before.length, 'no step added or dropped');
    migratedSteps.forEach((step, index) => {
      const path = `$.steps[${index}]`;
      const { criterionId, ...rest } = step;
      assert.deepEqual(rest, before[index], `${path} unchanged`);
      assert.equal(criterionId, mapping[path], `${path} carries the mapped criterion id, and only assertions carry one`);
    });
  });

  test(`${name}: migrating twice gives byte-identical output`, { criterion: 'AC-SPEC-01-08' }, () => {
    const first = migratePlan(legacyPlan(name), mappingFor(name));
    const second = migratePlan(legacyPlan(name), mappingFor(name));
    assert.ok(first.ok && second.ok);
    assert.equal(JSON.stringify(second.value), JSON.stringify(first.value));
  });

  test(`${name}: migration is pure, leaving its frozen input untouched`, { criterion: 'AC-SPEC-01-08' }, () => {
    const original = deepFreeze(legacyPlan(name));
    const mapping = deepFreeze(mappingFor(name));
    const migrated = migratePlan(original, mapping);
    assert.ok(migrated.ok, JSON.stringify(migrated));
    assert.deepEqual(original, legacyPlan(name));
  });

  test(`${name}: an assertion with no mapping entry fails with no_criterion_id and its path`, { criterion: 'AC-SPEC-01-08' }, () => {
    for (const missing of assertionPaths(legacyPlan(name))) {
      const { [missing]: _dropped, ...partial } = criterionMapping(name);
      const migrated = migratePlan(legacyPlan(name), partial as CriterionMapping);
      assert.deepEqual(migrated, { ok: false, error: [{ code: 'no_criterion_id', path: missing }] }, `without ${missing}`);
    }
  });
}

test('an empty mapping fails once for every assertion, each with its own path', { criterion: 'AC-SPEC-01-08' }, () => {
  const migrated = migratePlan(legacyPlan('signup'), {});
  assert.equal(migrated.ok, false);
  const found = migrated.ok ? [] : [...migrated.error].map((error) => `${error.code} ${error.path}`).sort();
  assert.deepEqual(found, assertionPaths(legacyPlan('signup')).map((path) => `no_criterion_id ${path}`).sort());
});

test('a migration error never echoes a value from the plan', { criterion: 'AC-SPEC-01-08' }, () => {
  const migrated = migratePlan(legacyPlan('signup'), {});
  assert.equal(migrated.ok, false);
  for (const text of ['ada@example.test', 'Ada Lovelace', 'Welcome', 'Create your account']) {
    assert.ok(!JSON.stringify(migrated).includes(text), `echoed ${text}`);
  }
});

// Counter-example for the failures above: the full mapping migrates every example.
test('the full mapping migrates every example', { criterion: 'AC-SPEC-01-08' }, () => {
  for (const name of migrationExampleNames()) assert.equal(migratePlan(legacyPlan(name), mappingFor(name)).ok, true, name);
});
