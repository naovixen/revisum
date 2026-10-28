// The plan grammar for declared calls (plan language 1.2). A plan may invoke a call only by the
// name the trusted project declares, with arguments typed by the declaration: literal values,
// run values by name, and secrets only by name. `call` steps may remember response fields as run
// values; `expectBackend` checks one field of a read call; a plan-level `cleanup` list holds calls
// only. Nothing a plan writes can name a URL, a method, a header or a body. Every refusal gives a
// code and a JSON path, echoes no value from the plan, and happens before any call is made.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, failure, runUntrusted, type BrowserDriver, type PlanErrorCode } from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { defaultParser, PRIVATE_MARKER, signupPlan, stepsOf } from './plan-examples.ts';
import { accepted, rejection, PREVIOUS_VERSION } from './run-value-examples.ts';
import {
  CREATE_ORDER, DELETE_ORDER, ORIGIN, RESET_SHOP, SECRET_VALUES, asJson, call, callParser, callPlanOf, callProject,
  expectBackend, fakeServiceCaller, orderArguments, withCleanup, type JsonRecord,
} from './service-call-examples.ts';

const parsePlan = callParser();

const PAID: JsonRecord = { kind: 'equals', value: 'paid' };
const READ_ORDER: JsonRecord = expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, 'status', PAID);
const frame = (steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator: { by: 'testId', testId: 'checkout-frame' }, steps });
const newTab = (steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url: '/orders', steps });
// createOrder's arguments with one of them left out.
const argumentsWithout = (name: string): JsonRecord => {
  const kept = orderArguments();
  delete kept[name];
  return kept;
};

// ---- Plans the parser accepts -------------------------------------------------------------------------

test('a call with literal arguments, remembering a response field, is accepted and kept as written', { criterion: 'AC-SPEC-32-02' }, () => {
  const plan = accepted(parsePlan, callPlanOf([CREATE_ORDER]));
  assert.deepEqual(asJson(plan.steps[0]), CREATE_ORDER);
});

test('a call may take run values by name for any parameter that is not a secret', { criterion: 'AC-SPEC-32-02' }, () => {
  const values = {
    buyer: { kind: 'uniqueText', prefix: 'buyer' }, buyerEmail: { kind: 'uniqueEmail', localPrefix: 'buyer' },
    count: { kind: 'uniqueNumber', digits: 4 },
  };
  const step = call('createOrder', orderArguments({
    customerName: { valueName: 'buyer' }, contactEmail: { valueName: 'buyerEmail' }, quantity: { valueName: 'count' },
  }));
  assert.deepEqual(asJson(accepted(parsePlan, callPlanOf([step], { values })).steps[0]), step);
});

test('a secret parameter takes a declared secret by name, and the plan holds only the name', { criterion: 'AC-SPEC-32-02' }, () => {
  const step = call('signInAsAdmin', { adminPassword: { secretName: 'SHOP_ADMIN_PASSWORD' } });
  const plan = accepted(parsePlan, callPlanOf([step]));
  assert.deepEqual(asJson(plan.steps[0]), step);
  assert.ok(!JSON.stringify(plan).includes(SECRET_VALUES['SHOP_ADMIN_PASSWORD'] ?? '?'), 'the plan holds the secret value');
});

test('an expectBackend on a read call, using a remembered value, is accepted and kept as written', { criterion: 'AC-SPEC-32-02' }, () => {
  const plan = accepted(parsePlan, callPlanOf([CREATE_ORDER, READ_ORDER]));
  assert.deepEqual(asJson(plan.steps[1]), READ_ORDER);
});

test('each backend assertion kind is accepted on expectBackend', { criterion: 'AC-SPEC-32-02' }, () => {
  for (const [field, assertion] of [
    ['status', { kind: 'present' }], ['status', { kind: 'absent' }], ['status', { kind: 'equals', value: 'paid' }],
    ['status', { kind: 'contains', value: 'pai' }], ['total', { kind: 'numberEquals', value: 42 }],
  ] as const) {
    accepted(parsePlan, callPlanOf([CREATE_ORDER, expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, field, assertion)]));
  }
});

test('a cleanup list of calls is accepted and may use values the steps remember', { criterion: 'AC-SPEC-32-02' }, () => {
  const plan = accepted(parsePlan, withCleanup(callPlanOf([CREATE_ORDER]), [DELETE_ORDER, RESET_SHOP]));
  assert.deepEqual(asJson(plan.cleanup), [DELETE_ORDER, RESET_SHOP]);
});

test('a call with no parameters takes an empty argument object', { criterion: 'AC-SPEC-32-02' }, () => {
  accepted(parsePlan, callPlanOf([RESET_SHOP]));
});

// ---- Undeclared names ---------------------------------------------------------------------------------

type RefusedCase = { readonly name: string; readonly plan: JsonRecord; readonly code: PlanErrorCode; readonly path: string };

// Each case changes one thing in a plan the parser accepts. Values from the plan are the private
// marker wherever a value, not a key, is wrong, so a test can see that no error echoes it.
const REFUSED: readonly RefusedCase[] = [
  { name: 'an undeclared call', plan: callPlanOf([call(PRIVATE_MARKER)]), code: 'unknown_value', path: '$.steps[0].call' },
  {
    name: 'an expectBackend naming an undeclared field',
    plan: callPlanOf([CREATE_ORDER, expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, PRIVATE_MARKER, PAID)]),
    code: 'unknown_value', path: '$.steps[1].field',
  },
  {
    name: 'a remember naming an undeclared field',
    plan: callPlanOf([call('createOrder', orderArguments(), { orderId: PRIVATE_MARKER })]), code: 'unknown_value', path: '$.steps[0].remember.orderId',
  },
  {
    name: 'a remember of a field the call does not declare, though another call does',
    plan: callPlanOf([call('createOrder', orderArguments(), { orderTotal: 'total' })]), code: 'unknown_value', path: '$.steps[0].remember.orderTotal',
  },
  {
    name: 'an expectBackend on a write call',
    plan: callPlanOf([expectBackend('createOrder', orderArguments(), 'status', PAID)]), code: 'unknown_value', path: '$.steps[0].call',
  },
  // ---- Arguments ----
  {
    name: 'a missing argument', plan: callPlanOf([call('createOrder', argumentsWithout('quantity'))]),
    code: 'missing_field', path: '$.steps[0].arguments.quantity',
  },
  {
    name: 'an argument the declaration does not have', plan: callPlanOf([call('createOrder', orderArguments({ discountPercent: 100 }))]),
    code: 'unknown_field', path: '$.steps[0].arguments.discountPercent',
  },
  {
    name: 'text for an integer', plan: callPlanOf([call('createOrder', orderArguments({ quantity: PRIVATE_MARKER }))]),
    code: 'wrong_type', path: '$.steps[0].arguments.quantity',
  },
  {
    name: 'text for a boolean', plan: callPlanOf([call('createOrder', orderArguments({ giftWrap: PRIVATE_MARKER }))]),
    code: 'wrong_type', path: '$.steps[0].arguments.giftWrap',
  },
  {
    name: 'a number for text', plan: callPlanOf([call('createOrder', orderArguments({ customerName: 42 }))]),
    code: 'wrong_type', path: '$.steps[0].arguments.customerName',
  },
  {
    name: 'text over the parameter\'s maximum length', plan: callPlanOf([call('createOrder', orderArguments({ customerName: `${PRIVATE_MARKER}${'x'.repeat(30)}` }))]),
    code: 'too_long', path: '$.steps[0].arguments.customerName',
  },
  {
    name: 'a value outside the oneOf list', plan: callPlanOf([call('createOrder', orderArguments({ region: PRIVATE_MARKER }))]),
    code: 'unknown_value', path: '$.steps[0].arguments.region',
  },
  {
    name: 'a literal in a secret parameter', plan: callPlanOf([call('signInAsAdmin', { adminPassword: PRIVATE_MARKER })]),
    code: 'literal_secret', path: '$.steps[0].arguments.adminPassword',
  },
  {
    name: 'a text argument holding a line break', plan: callPlanOf([call('createOrder', orderArguments({ customerName: `Ada\r\n${PRIVATE_MARKER}` }))]),
    code: 'unsafe_text', path: '$.steps[0].arguments.customerName',
  },
  // ---- Fields a plan may never write ----
  ...['url', 'method', 'headers', 'body', 'service', 'path', 'query'].map((field): RefusedCase => ({
    name: `a call step that sets its own ${field}`, plan: callPlanOf([{ ...CREATE_ORDER, [field]: PRIVATE_MARKER }]),
    code: 'unknown_field', path: `$.steps[0].${field}`,
  })),
  {
    name: 'an expectBackend that sets its own headers',
    plan: callPlanOf([CREATE_ORDER, { ...READ_ORDER, headers: { authorization: PRIVATE_MARKER } }]), code: 'unknown_field', path: '$.steps[1].headers',
  },
  {
    name: 'a cleanup call that sets its own URL',
    plan: withCleanup(callPlanOf([CREATE_ORDER]), [{ ...DELETE_ORDER, url: `https://evil.example/${PRIVATE_MARKER}` }]), code: 'unknown_field', path: '$.cleanup[0].url',
  },
  // ---- Where calls may stand ----
  { name: 'a call inside a frame', plan: callPlanOf([frame([CREATE_ORDER])]), code: 'misplaced_step', path: '$.steps[0].steps[0]' },
  { name: 'a call inside a newTab', plan: callPlanOf([newTab([CREATE_ORDER])]), code: 'misplaced_step', path: '$.steps[0].steps[0]' },
  {
    name: 'an expectBackend inside a frame', plan: callPlanOf([CREATE_ORDER, frame([READ_ORDER])]), code: 'misplaced_step', path: '$.steps[1].steps[0]',
  },
  {
    name: 'a navigate in cleanup', plan: withCleanup(callPlanOf([CREATE_ORDER]), [{ type: 'navigate', url: '/orders' }]),
    code: 'misplaced_step', path: '$.cleanup[0]',
  },
  { name: 'an expectBackend in cleanup', plan: withCleanup(callPlanOf([CREATE_ORDER]), [READ_ORDER]), code: 'misplaced_step', path: '$.cleanup[0]' },
];

// The path of a misplaced step: the step itself, or its type field, as unknown_step reports it.
const acceptsPath = (refused: RefusedCase, path: string): boolean =>
  path === refused.path || (refused.code === 'misplaced_step' && path === `${refused.path}.type`);

for (const refused of REFUSED) {
  test(`${refused.name} is refused with ${refused.code} at ${refused.path}`, { criterion: 'AC-SPEC-32-02' }, () => {
    const errors = rejection(parsePlan, refused.plan);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    const [code, path = ''] = (errors[0] ?? '').split(' ');
    assert.equal(code, refused.code, JSON.stringify(errors));
    assert.ok(acceptsPath(refused, path), JSON.stringify(errors));
  });
}

test('no refusal echoes the value the plan wrote', { criterion: 'AC-SPEC-32-02' }, () => {
  const withMarker = REFUSED.filter((refused) => JSON.stringify(refused.plan).includes(PRIVATE_MARKER));
  assert.ok(withMarker.length >= 10, 'most cases carry the private marker');
  for (const refused of withMarker) {
    const parsed = parsePlan(refused.plan);
    assert.equal(parsed.ok, false, refused.name);
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), `${refused.name}: ${JSON.stringify(parsed)}`);
  }
});

// Arguments whose code the spec leaves to the parser: each is still refused, and every error is
// at the argument or inside it.
const assertRefusedInside = (errors: readonly string[], path: string, label: string): void => {
  assert.ok(errors.length > 0, label);
  for (const error of errors) {
    const found = error.split(' ')[1] ?? '';
    assert.ok(found === path || found.startsWith(`${path}.`), `${label}: ${JSON.stringify(errors)}`);
  }
};

test('an integer outside its range, a malformed email or day, or a null is refused at the argument', { criterion: 'AC-SPEC-32-02' }, () => {
  for (const [argument, value] of [
    ['quantity', 0], ['quantity', 100], ['quantity', 2.5], ['contactEmail', 'not-an-email'], ['deliveryDay', '2026-02-30'],
    ['deliveryDay', '02.11.2026'], ['giftWrap', null],
  ] as const) {
    const label = `${argument} ${JSON.stringify(value)}`;
    assertRefusedInside(rejection(parsePlan, callPlanOf([call('createOrder', orderArguments({ [argument]: value }))])), `$.steps[0].arguments.${argument}`, label);
  }
});

test('a secret reference or a template object for a text parameter is refused at the argument', { criterion: 'AC-SPEC-32-02' }, () => {
  for (const value of [{ secretName: 'SHOP_API_TOKEN' }, { $parameter: 'quantity' }, { $interpolate: '{quantity}', parameters: ['quantity'] }]) {
    assertRefusedInside(rejection(parsePlan, callPlanOf([call('createOrder', orderArguments({ customerName: value }))])), '$.steps[0].arguments.customerName', JSON.stringify(value));
  }
});

test('a secret parameter given an undeclared secret or a run value is refused at the argument', { criterion: 'AC-SPEC-32-02' }, () => {
  for (const value of [{ secretName: 'PRODUCTION_DATABASE_URL' }, { valueName: 'orderId' }]) {
    assertRefusedInside(rejection(parsePlan, callPlanOf([CREATE_ORDER, call('signInAsAdmin', { adminPassword: value })])), '$.steps[1].arguments.adminPassword', JSON.stringify(value));
  }
});

test('arguments that are not an object, or a remember that is not an object, are refused as wrong_type', { criterion: 'AC-SPEC-32-02' }, () => {
  assert.deepEqual(rejection(parsePlan, callPlanOf([call('resetShop', [])])), ['wrong_type $.steps[0].arguments']);
  assert.deepEqual(rejection(parsePlan, callPlanOf([call('createOrder', orderArguments(), 'orderId')])), ['wrong_type $.steps[0].remember']);
});

test('an expectBackend without a criterion id is refused as vacuous', { criterion: 'AC-SPEC-32-02' }, () => {
  const { criterionId: _removed, ...untraced } = READ_ORDER;
  const errors = rejection(parsePlan, callPlanOf([CREATE_ORDER, untraced]));
  assert.ok(errors.length > 0 && errors.every((error) => error.startsWith('vacuous $.steps[1]')), JSON.stringify(errors));
});

test('an expectBackend with an assertion kind the language does not have is refused at the kind', { criterion: 'AC-SPEC-32-02' }, () => {
  for (const kind of ['matches', 'greaterThan', 'jsonPath']) {
    const errors = rejection(parsePlan, callPlanOf([CREATE_ORDER, { ...READ_ORDER, assert: { kind, value: 'paid' } }]));
    assert.deepEqual(errors, ['unknown_value $.steps[1].assert.kind'], kind);
  }
});

// ---- Remembered values follow the run-value rules --------------------------------------------------

test('a remembered value used before the call that remembers it is refused with undefined_value', { criterion: 'AC-SPEC-32-02' }, () => {
  assert.deepEqual(rejection(parsePlan, callPlanOf([READ_ORDER, CREATE_ORDER])), ['undefined_value $.steps[0].arguments.orderId']);
});

test('a remembered value with the name of a generated value is refused as duplicate', { criterion: 'AC-SPEC-32-02' }, () => {
  const errors = rejection(parsePlan, callPlanOf([CREATE_ORDER], { values: { orderId: { kind: 'uniqueText', prefix: 'order' } } }));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

test('a cleanup call naming a value no step defines is refused with undefined_value', { criterion: 'AC-SPEC-32-02' }, () => {
  assert.deepEqual(rejection(parsePlan, withCleanup(callPlanOf([RESET_SHOP]), [DELETE_ORDER])), ['undefined_value $.cleanup[0].arguments.orderId']);
});

// ---- Version 1.1 -----------------------------------------------------------------------------------

// Recorded from the parser before calls existed, when it read them as a 1.1 parser does.
test('a plan declaring 1.1 that uses a call, an expectBackend or cleanup is refused as a 1.1 parser refuses it', { criterion: 'AC-SPEC-32-02' }, () => {
  const parse = defaultParser();
  const previousWith = (added: JsonRecord): JsonRecord => {
    const steps = [...stepsOf(signupPlan())];
    steps.splice(1, 0, added);
    return { ...signupPlan(), steps };
  };
  assert.equal(signupPlan()['version'], PREVIOUS_VERSION);
  assert.deepEqual(rejection(parse, previousWith(RESET_SHOP)), ['unknown_step $.steps[1].type']);
  assert.deepEqual(rejection(parse, previousWith(READ_ORDER)), ['unknown_step $.steps[1].type']);
  assert.deepEqual(rejection(parse, { ...signupPlan(), cleanup: [RESET_SHOP] }), ['unknown_field $.cleanup']);
});

// ---- No call is made for a refused plan -----------------------------------------------------------------

test('a refused plan reaches neither the service caller nor the driver, and nothing is logged', { criterion: 'AC-SPEC-32-02' }, async () => {
  let driverCalls = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { driverCalls++; return { ok: true, value: true }; },
    async open() { driverCalls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const { caller, requests } = fakeServiceCaller();
  const events = memoryRunEventSink();
  const ports = {
    drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events,
    services: caller,
  };
  const base = { project: callProject(), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  for (const refused of REFUSED) {
    const outcome = await runUntrusted(refused.plan, parsePlan, base, ports);
    assert.ok('errors' in outcome, `${refused.name}: ${JSON.stringify(outcome)}`);
  }
  assert.equal(requests.length, 0, 'no call was made');
  assert.equal(driverCalls, 0, 'no driver method was called');
  assert.equal(events.read().length, 0, 'nothing was logged');
});

// ---- Cleanup holds call steps only ---------------------------------------------------------------------------

const STATUS_CHECK: JsonRecord = { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'orders.status-shown' };
const NOT_CALLS: readonly JsonRecord[] = [
  { type: 'click', locator: { by: 'role', role: 'button', name: 'Cancel order' } },
  { type: 'fill', locator: { by: 'label', label: 'Reason' }, value: 'cleanup' },
  STATUS_CHECK,
  { type: 'capture', name: 'after-cleanup' },
  { type: 'a11yAudit', mode: 'report' },
  frame([STATUS_CHECK]),
  newTab([STATUS_CHECK]),
];

for (const step of NOT_CALLS) {
  test(`a ${String(step['type'])} step in cleanup is refused with misplaced_step at that cleanup entry`, { criterion: 'AC-SPEC-32-02' }, () => {
    const errors = rejection(parsePlan, withCleanup(callPlanOf([CREATE_ORDER]), [RESET_SHOP, step]));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(['misplaced_step $.cleanup[1]', 'misplaced_step $.cleanup[1].type'].includes(errors[0] ?? ''), JSON.stringify(errors));
  });
}

// Counter-example: the same steps in the plan's steps are not misplaced.
test('the same click and capture in the plan\'s steps are accepted', { criterion: 'AC-SPEC-32-02' }, () => {
  accepted(parsePlan, callPlanOf([{ type: 'navigate', url: '/orders' }, NOT_CALLS[0], NOT_CALLS[3]]));
});
