// Where a plan may use a run value, and when. A reference { "valueName": … } may stand only where
// a plan would write literal text for the page: fill values and lines, select options, locator
// texts, expected texts, dialog text and path-template segments and query values. Everywhere else
// it is refused, echoing nothing. A value must be defined before it is used, and only once; a plan
// that breaks either rule never reaches a driver.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, failure, runUntrusted, type BrowserDriver } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import {
  CLOSING_CHECK, OPEN_ORDERS, ORIGIN, accepted, label, navigate, parserFor, planOf, projectWith, reference, rejection,
  type JsonRecord,
} from './run-value-examples.ts';

// The project declares one secret and one fixture, so that their names are real declarations.
const PROJECT_FIELDS: JsonRecord = { secretNames: ['ORDER_PIN'], fixtures: ['invoice.pdf'], testIdAttributes: ['data-testid', 'data-qa'] };
const parsePlan = parserFor(PROJECT_FIELDS);

// A defined value whose name and prefix must never appear in an error.
const MARKED = 'privateMarkerQz7x';
const MARKED_PREFIX = 'private-marker-q7zx';
const VALUES: JsonRecord = { [MARKED]: { kind: 'uniqueText', prefix: MARKED_PREFIX } };
const MARKED_REFERENCE = reference(MARKED);
const withValues = (steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => planOf(steps, { values: VALUES, ...fields });

const ORDER_FIELD = label('Order number');
const fill = (value: unknown): JsonRecord => ({ type: 'fill', locator: ORDER_FIELD, value });
const remember = (name: unknown, element: JsonRecord = label('Order reference')): JsonRecord =>
  ({ type: 'remember', name, from: { element, read: 'text' } });

// The error for an undefined reference sits on the reference itself.
function assertUndefinedAt(errors: readonly string[], referencePath: string): void {
  assert.deepEqual(errors, [`undefined_value ${referencePath}`]);
}

// ---- Defined before use, and only once ----------------------------------------------------------

test('a reference to a value the plan never defines is refused with undefined_value at the reference', { criterion: 'AC-SPEC-30-07' }, () => {
  assertUndefinedAt(rejection(parsePlan, withValues([OPEN_ORDERS, fill(reference('missingValue'))])), '$.steps[1].value');
});

test('a reference to a remembered value before the step that remembers it is refused with undefined_value', { criterion: 'AC-SPEC-30-07' }, () => {
  const plan = planOf([OPEN_ORDERS, fill(reference('orderNumber')), remember('orderNumber')]);
  assertUndefinedAt(rejection(parsePlan, plan), '$.steps[1].value');
});

test('a remember step cannot use the value it is still defining in its own locator', { criterion: 'AC-SPEC-30-07' }, () => {
  const plan = planOf([OPEN_ORDERS, remember('orderNumber', label(reference('orderNumber')))]);
  assertUndefinedAt(rejection(parsePlan, plan), '$.steps[1].from.element.label');
});

test('an undefined reference inside a path template is refused at its segment', { criterion: 'AC-SPEC-30-07' }, () => {
  const plan = planOf([navigate({ segments: ['orders', reference('missingValue')] })]);
  assertUndefinedAt(rejection(parsePlan, plan), '$.steps[0].url.segments[1]');
});

test('a value defined in the plan\'s values and remembered again is refused as duplicate', { criterion: 'AC-SPEC-30-07' }, () => {
  const errors = rejection(parsePlan, withValues([OPEN_ORDERS, remember(MARKED)]));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

test('a value remembered twice is refused as duplicate', { criterion: 'AC-SPEC-30-07' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, remember('orderNumber'), remember('orderNumber', label('Order total'))]));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

test('a remember step may read only text or value', { criterion: 'AC-SPEC-30-07' }, () => {
  const plan = planOf([OPEN_ORDERS, { type: 'remember', name: 'orderNumber', from: { element: ORDER_FIELD, read: 'attribute' } }]);
  assert.deepEqual(rejection(parsePlan, plan), ['unknown_value $.steps[1].from.read']);
});

// Counter-examples: the same plans in a valid order are accepted.
test('a value used after its definition is accepted, from the values and from a remember step', { criterion: 'AC-SPEC-30-07' }, () => {
  accepted(parsePlan, withValues([OPEN_ORDERS, fill(MARKED_REFERENCE)]));
  accepted(parsePlan, planOf([OPEN_ORDERS, remember('orderNumber'), fill(reference('orderNumber'))]));
});

test('a value remembered inside a frame is visible to the steps after the frame', { criterion: 'AC-SPEC-30-07' }, () => {
  const frame = { type: 'frame', locator: { by: 'testId', testId: 'checkout-frame' }, steps: [remember('orderNumber'), CLOSING_CHECK] };
  accepted(parsePlan, planOf([OPEN_ORDERS, frame, fill(reference('orderNumber'))]));
});

test('a plan with an undefined or duplicate value is refused before any driver is touched', { criterion: 'AC-SPEC-30-07' }, async () => {
  let calls = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { calls++; return { ok: true, value: true }; },
    async open() { calls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const events = memoryRunEventSink();
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events };
  const base = {
    project: projectWith(PROJECT_FIELDS), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [],
    host: { platform: platform(), arch: arch() },
  };
  for (const plan of [withValues([OPEN_ORDERS, fill(reference('missingValue'))]), withValues([OPEN_ORDERS, remember(MARKED)])]) {
    const outcome = await runUntrusted(plan, parsePlan, base, ports);
    assert.ok(!Array.isArray(outcome) && 'errors' in outcome, JSON.stringify(outcome));
  }
  assert.equal(calls, 0, 'no driver method was called');
  assert.equal(events.read().length, 0, 'nothing was logged');

  // Positive control: a valid plan using a value does reach the driver.
  await runUntrusted(withValues([OPEN_ORDERS, fill(MARKED_REFERENCE)]), parsePlan, base, ports);
  assert.ok(calls > 0, 'a valid plan reaches the driver, so the zero above is meaningful');
});

// ---- Places a reference may not stand ------------------------------------------------------------

// `code`, when given, is the one code the place must give.
type Place = { readonly name: string; readonly plan: JsonRecord; readonly path: string; readonly code?: string };

const press = (fields: JsonRecord): JsonRecord => ({ type: 'press', locator: ORDER_FIELD, key: 'Enter', ...fields });
const expectPage = (kind: string, value: unknown): JsonRecord => ({ type: 'expectPage', assert: { kind, value }, criterionId: 'orders.page' });

const PLACES: readonly Place[] = [
  { name: 'a criterion id', plan: withValues([OPEN_ORDERS, { ...CLOSING_CHECK, criterionId: MARKED_REFERENCE }]), path: '$.steps[1].criterionId' },
  { name: 'a capture name', plan: withValues([OPEN_ORDERS, { type: 'capture', name: MARKED_REFERENCE }]), path: '$.steps[1].name', code: 'wrong_type' },
  { name: 'a target', plan: withValues([OPEN_ORDERS], { targets: [MARKED_REFERENCE] }), path: '$.targets[0]' },
  { name: 'a key', plan: withValues([OPEN_ORDERS, press({ key: MARKED_REFERENCE })]), path: '$.steps[1].key' },
  { name: 'a key modifier', plan: withValues([OPEN_ORDERS, press({ key: 'k', modifiers: [MARKED_REFERENCE] })]), path: '$.steps[1].modifiers[0]' },
  { name: 'a secret name in a fill', plan: withValues([OPEN_ORDERS, fill({ secretName: MARKED_REFERENCE })]), path: '$.steps[1].value.secretName' },
  { name: 'the secret name of the storage state', plan: withValues([OPEN_ORDERS], { storageState: { secretName: MARKED_REFERENCE } }), path: '$.storageState.secretName' },
  { name: 'a whole navigate URL', plan: withValues([navigate(MARKED_REFERENCE)]), path: '$.steps[0].url' },
  { name: 'the origin of a path template', plan: withValues([navigate({ segments: ['orders'], origin: MARKED_REFERENCE })]), path: '$.steps[0].url' },
  { name: 'an absolute URL in a page check', plan: withValues([OPEN_ORDERS, expectPage('url', MARKED_REFERENCE)]), path: '$.steps[1].assert.value' },
  { name: 'a URL prefix check', plan: withValues([OPEN_ORDERS, expectPage('urlPathStartsWith', MARKED_REFERENCE)]), path: '$.steps[1].assert.value' },
  { name: 'a page path check', plan: withValues([OPEN_ORDERS, expectPage('urlPath', MARKED_REFERENCE)]), path: '$.steps[1].assert.value' },
  { name: 'a fixture name', plan: withValues([OPEN_ORDERS, { type: 'upload', locator: label('Invoice'), fixture: MARKED_REFERENCE }]), path: '$.steps[1].fixture' },
  { name: 'a test-id attribute', plan: withValues([OPEN_ORDERS, { type: 'click', locator: { by: 'testId', testId: 'save', attribute: MARKED_REFERENCE } }]), path: '$.steps[1].locator.attribute' },
  { name: 'an email domain', plan: planOf([OPEN_ORDERS], { values: { ...VALUES, contact: { kind: 'uniqueEmail', localPrefix: 'ada', domain: MARKED_REFERENCE } } }), path: '$.values.contact.domain' },
  { name: 'the name a remember step defines', plan: withValues([OPEN_ORDERS, remember(MARKED_REFERENCE)]), path: '$.steps[1].name' },
  { name: 'a role', plan: withValues([OPEN_ORDERS, { type: 'click', locator: { by: 'role', role: MARKED_REFERENCE, name: 'Open' } }]), path: '$.steps[1].locator.role' },
  { name: 'the plan title', plan: withValues([OPEN_ORDERS], { meta: { featureId: 'ORDERS-1', specReference: 'specs/orders.md', title: MARKED_REFERENCE } }), path: '$.meta.title' },
  { name: 'a generated value\'s prefix', plan: planOf([OPEN_ORDERS], { values: { ...VALUES, orderCode: { kind: 'uniqueText', prefix: MARKED_REFERENCE } } }), path: '$.values.orderCode.prefix' },
  { name: 'the plan clock\'s time', plan: withValues([OPEN_ORDERS], { clock: { day: { from: 'today', addDays: 0 }, time: MARKED_REFERENCE } }), path: '$.clock.time' },
];

const atOrBelow = (path: string, place: string): boolean =>
  path === place || path.startsWith(`${place}.`) || path.startsWith(`${place}[`);

for (const place of PLACES) {
  test(`a value reference in ${place.name} is refused with wrong_type or unknown_field at ${place.path}`, { criterion: 'AC-SPEC-30-08' }, () => {
    const parsed = parsePlan(place.plan);
    assert.equal(parsed.ok, false, 'the plan was accepted');
    const errors = parsed.ok ? [] : parsed.error;
    assert.ok(
      errors.some((error) => (error.code === 'wrong_type' || error.code === 'unknown_field') && atOrBelow(error.path, place.path)),
      JSON.stringify(errors),
    );
    if (place.code !== undefined) assert.deepEqual(errors, [{ code: place.code, path: place.path }]);
    for (const error of errors) assert.ok(atOrBelow(error.path, place.path), `an error outside ${place.path}: ${JSON.stringify(error)}`);
    const text = JSON.stringify(parsed);
    assert.ok(!text.includes(MARKED) && !text.includes(MARKED_PREFIX), `the error echoed a value: ${text}`);
  });
}

// Counter-example: the same reference is accepted in every place the language allows it.
test('the same reference is accepted in every place where a plan writes text for the page', { criterion: 'AC-SPEC-30-08' }, () => {
  const allowed: readonly unknown[] = [
    navigate({ segments: ['orders', MARKED_REFERENCE], query: { search: MARKED_REFERENCE } }),
    fill(MARKED_REFERENCE),
    fill({ lines: ['Order', MARKED_REFERENCE] }),
    { type: 'select', locator: label('Saved orders'), option: MARKED_REFERENCE },
    { type: 'click', locator: { by: 'role', role: 'link', name: MARKED_REFERENCE } },
    { type: 'click', locator: label(MARKED_REFERENCE) },
    { type: 'click', locator: { by: 'text', text: MARKED_REFERENCE } },
    { type: 'click', locator: { by: 'testId', testId: MARKED_REFERENCE } },
    { type: 'expect', locator: ORDER_FIELD, assert: { kind: 'textEquals', value: MARKED_REFERENCE }, criterionId: 'orders.code-shown' },
    { type: 'expect', locator: ORDER_FIELD, assert: { kind: 'valueContains', value: MARKED_REFERENCE }, criterionId: 'orders.code-kept' },
    { type: 'dialog', action: 'accept', expectText: MARKED_REFERENCE },
  ];
  accepted(parsePlan, withValues(allowed));
});
