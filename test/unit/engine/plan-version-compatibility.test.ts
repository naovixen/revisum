// Plan language 1.2 parses every 1.1 plan unchanged. A plan declaring "1.1" gives the same plan it
// gave before 1.2 existed, kept in golden/parsed-plans/, and a 1.2 feature in a plan declaring
// "1.1" is refused with exactly the code and path a 1.1 parser gave. Those codes were recorded
// from the 1.1 parser itself, before any 1.2 code existed.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { migratePlan, type CriterionMapping } from '@revisum/engine';
import { GOLDEN } from '../../support/repository.ts';
import { criterionMapping, defaultParser, goldenPlan, goldenPlanNames, legacyPlan, signupPlan, stepsOf } from './plan-examples.ts';
import { NEW_VERSION, PREVIOUS_VERSION, label, type JsonRecord } from './run-value-examples.ts';

const parsePlan = defaultParser();
const PARSED_FOLDER = join(GOLDEN, 'parsed-plans');

const previousGoldenNames = (): string[] => goldenPlanNames().filter((name) => goldenPlan(name)['version'] === PREVIOUS_VERSION);
const storedResult = (name: string): unknown => JSON.parse(readFileSync(join(PARSED_FOLDER, `${name}.json`), 'utf8'));

// ---- 1.1 golden plans parse to the same plan -------------------------------------------------------

test('every 1.1 golden plan has its 1.1 parse result stored, and no other plan does', { criterion: 'AC-SPEC-30-01' }, () => {
  const stored = readdirSync(PARSED_FOLDER).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
  assert.ok(previousGoldenNames().length >= 4, 'the 1.1 golden plans are still there');
  assert.deepEqual(stored, previousGoldenNames());
});

for (const name of previousGoldenNames()) {
  test(`the 1.1 golden plan "${name}" parses to exactly its stored 1.1 result`, { criterion: 'AC-SPEC-30-01' }, () => {
    const parsed = parsePlan(goldenPlan(name));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.value)), storedResult(name));
  });
}

test('a 1.1 plan keeps declaring "1.1" once parsed, rather than being moved to the newer version', { criterion: 'AC-SPEC-30-01' }, () => {
  const parsed = parsePlan(signupPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.value.version, PREVIOUS_VERSION);
});

test('a version 1 plan still migrates to a 1.1 plan, which the parser accepts', { criterion: 'AC-SPEC-30-01' }, () => {
  // The mapping file holds plain strings; the cast stands in for the author who writes it by hand.
  const migrated = migratePlan(legacyPlan('signup'), criterionMapping('signup') as CriterionMapping);
  assert.ok(migrated.ok, JSON.stringify(migrated));
  assert.equal(migrated.value.version, PREVIOUS_VERSION);
  assert.equal(parsePlan(migrated.value).ok, true);
});

// Counter-example: the same 1.1 steps declared as "1.2" are accepted and keep "1.2", so the
// version a plan declares is what decides its grammar.
test('the same steps declared as "1.2" parse too, keeping the declared version', { criterion: 'AC-SPEC-30-01' }, () => {
  const parsed = parsePlan({ ...signupPlan(), version: NEW_VERSION });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.value.version, NEW_VERSION);
  assert.deepEqual(parsed.value.steps, stepsOf(signupPlan()));
});

test('a plan declaring a version newer than 1.2 is still refused with version_unsupported', { criterion: 'AC-SPEC-30-01' }, () => {
  for (const version of ['1.3', '1.20', '2.0']) {
    assert.deepEqual(parsePlan({ ...signupPlan(), version }), { ok: false, error: [{ code: 'version_unsupported', path: '$.version' }] }, version);
  }
});

// ---- 1.2 features in a plan declaring "1.1" ------------------------------------------------------

const ORDER_FIELD = label('Order number');

// A sign-up plan declaring "1.1", with `step` inserted as step 1.
const previousPlanWithStep = (step: JsonRecord): JsonRecord => {
  const steps = [...stepsOf(signupPlan())];
  steps.splice(1, 0, step);
  return { ...signupPlan(), steps };
};

type PreviousCase = { readonly feature: string; readonly plan: () => JsonRecord; readonly errors: readonly string[] };

// Each expected rejection is what the 1.1 parser returned for that plan.
const PREVIOUS_CASES: readonly PreviousCase[] = [
  { feature: 'generated values', plan: () => ({ ...signupPlan(), values: { orderNumber: { kind: 'uniqueNumber', digits: 6 } } }), errors: ['unknown_field $.values'] },
  { feature: 'a plan clock', plan: () => ({ ...signupPlan(), clock: { day: { from: 'today', addDays: 1 }, time: '09:00' } }), errors: ['unknown_field $.clock'] },
  { feature: 'a remember step', plan: () => previousPlanWithStep({ type: 'remember', name: 'orderNumber', from: { element: ORDER_FIELD, read: 'text' } }), errors: ['unknown_step $.steps[1].type'] },
  { feature: 'a position', plan: () => previousPlanWithStep({ type: 'click', locator: { by: 'role', role: 'button', name: 'Open', position: 2 } }), errors: ['unknown_field $.steps[1].locator.position'] },
  { feature: 'a test-id attribute', plan: () => previousPlanWithStep({ type: 'click', locator: { by: 'testId', testId: 'save', attribute: 'data-testid' } }), errors: ['unknown_field $.steps[1].locator.attribute'] },
  { feature: 'key modifiers', plan: () => previousPlanWithStep({ type: 'press', locator: ORDER_FIELD, key: 'Enter', modifiers: ['Control'] }), errors: ['unknown_field $.steps[1].modifiers'] },
  { feature: 'a letter key', plan: () => previousPlanWithStep({ type: 'press', locator: ORDER_FIELD, key: 'k' }), errors: ['unknown_value $.steps[1].key'] },
  { feature: 'a function key', plan: () => previousPlanWithStep({ type: 'press', locator: ORDER_FIELD, key: `F${5}` }), errors: ['unknown_value $.steps[1].key'] },
  { feature: 'a multi-line fill', plan: () => previousPlanWithStep({ type: 'fill', locator: ORDER_FIELD, value: { lines: ['one', 'two'] } }), errors: ['unknown_field $.steps[1].value.lines', 'missing_field $.steps[1].value.secretName'] },
  { feature: 'a value reference in a fill', plan: () => previousPlanWithStep({ type: 'fill', locator: ORDER_FIELD, value: { valueName: 'orderNumber' } }), errors: ['unknown_field $.steps[1].value.valueName', 'missing_field $.steps[1].value.secretName'] },
  { feature: 'a value reference in a select', plan: () => previousPlanWithStep({ type: 'select', locator: ORDER_FIELD, option: { valueName: 'orderNumber' } }), errors: ['wrong_type $.steps[1].option'] },
  { feature: 'a value reference in a locator', plan: () => previousPlanWithStep({ type: 'click', locator: label({ valueName: 'orderNumber' }) }), errors: ['wrong_type $.steps[1].locator.label'] },
  { feature: 'a value reference in a dialog check', plan: () => previousPlanWithStep({ type: 'dialog', action: 'accept', expectText: { valueName: 'orderNumber' } }), errors: ['wrong_type $.steps[1].expectText'] },
  { feature: 'a path template', plan: () => previousPlanWithStep({ type: 'navigate', url: { segments: ['orders', 'latest'] } }), errors: ['wrong_type $.steps[1].url'] },
  { feature: 'a URL-prefix check', plan: () => previousPlanWithStep({ type: 'expectPage', assert: { kind: 'urlPathStartsWith', value: '/orders' }, criterionId: 'orders.page' }), errors: ['unknown_value $.steps[1].assert.kind'] },
  { feature: 'a value reference in a text check', plan: () => previousPlanWithStep({ type: 'expect', locator: ORDER_FIELD, assert: { kind: 'textEquals', value: { valueName: 'orderNumber' } }, criterionId: 'orders.number' }), errors: ['wrong_type $.steps[1].assert.value'] },
];

for (const previous of PREVIOUS_CASES) {
  test(`a plan declaring "1.1" that uses ${previous.feature} is refused as a 1.1 parser refuses it`, { criterion: 'AC-SPEC-30-01' }, () => {
    const parsed = parsePlan(previous.plan());
    assert.equal(parsed.ok, false, 'the plan was accepted');
    assert.deepEqual(parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`), previous.errors);
  });
}

// Counter-example: each of those plans, declared as "1.2", is not refused for the same reasons.
// (Some still fail for other reasons, such as an undefined value, so only the 1.1 errors are compared.)
test('declared as "1.2", none of those plans is refused with the errors a 1.1 parser gives', { criterion: 'AC-SPEC-30-01' }, () => {
  for (const previous of PREVIOUS_CASES) {
    const parsed = parsePlan({ ...previous.plan(), version: NEW_VERSION });
    const errors = parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`);
    assert.notDeepEqual(errors, previous.errors, previous.feature);
  }
});
