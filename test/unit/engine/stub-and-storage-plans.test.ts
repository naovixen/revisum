// The plan grammar for declared stubs, request checks and storage (plan language 1.2). A plan may
// start and stop a stub, reset and check the requests a declared matcher sees, check or remember a
// field of the latest response, and write, remove or check a storage entry, each only by the name
// the trusted project declares, with arguments typed by the declaration. Nothing a plan writes can
// name a URL, a response, a header, a storage key or a value to store. Every refusal gives a code
// and a JSON path, echoes no value from the plan, and happens before any driver call.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, failure, runUntrusted, type BrowserDriver, type PlanErrorCode } from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { PRIVATE_MARKER, defaultParser, signupPlan, stepsOf } from './plan-examples.ts';
import { PREVIOUS_VERSION, accepted, rejection, type ParsePlan } from './run-value-examples.ts';
import {
  ORIGIN, TOKEN_SECRET, asJson, expectRequests, expectResponse, expectStorage, planOf, rememberResponse, removeStorage, resetRequests,
  setStorage, startStub, stopStub, stubParser, stubProject, type JsonRecord,
} from './stub-and-storage-examples.ts';

// Built on first use, so each test reports its own failure while the project parser lacks a section.
let parser: ParsePlan | undefined;
const parsePlan: ParsePlan = (input) => {
  parser ??= stubParser();
  return parser(input);
};

const OPEN_LOGIN: JsonRecord = { type: 'navigate', url: '/login' };
const LIKE_COUNT: JsonRecord = { by: 'testId', testId: 'like-count' };
const frame = (steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator: { by: 'testId', testId: 'login-frame' }, steps });
const newTab = (steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url: '/login', steps });
const LOGIN_ARGUMENTS: JsonRecord = { reason: 'Enter the code from your app' };

// ---- Plans the parser accepts --------------------------------------------------------------------

const ACCEPTED_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'a stub start with arguments', step: startStub('loginNeedsCode', LOGIN_ARGUMENTS) },
  { name: 'a stub start without arguments, for a stub with no parameters', step: startStub('cartEmpty') },
  { name: 'a resetRequests', step: resetRequests('likes') },
  ...[{ equals: 2 }, { atLeast: 1 }, { atMost: 1 }, { equals: 0 }].map((count) => ({ name: `an expectRequests counting ${JSON.stringify(count)}`, step: expectRequests('scheduleLoads', count) })),
  ...[
    { kind: 'statusEquals', value: 200 }, { kind: 'fieldPresent', field: 'likeList' }, { kind: 'fieldAbsent', field: 'errorCode' },
    { kind: 'fieldEquals', field: 'firstLiker', value: 'Ada' }, { kind: 'fieldContains', field: 'firstLiker', value: 'Ad' },
  ].map((assertion) => ({ name: `an expectResponse with ${assertion.kind}`, step: expectResponse('likes', assertion) })),
  { name: 'a statusEquals on a request that declares no fields', step: expectResponse('scheduleLoads', { kind: 'statusEquals', value: 200 }) },
  { name: 'a setStorage with arguments', step: setStorage('pinnedMenu', { docked: true }) },
  { name: 'a setStorage without arguments, for an entry with no parameters', step: setStorage('welcomeDismissed') },
  { name: 'a setStorage naming a declared secret for a secret parameter', step: setStorage('sessionToken', { token: { secretName: TOKEN_SECRET } }) },
  { name: 'a removeStorage', step: removeStorage('pinnedMenu') },
  ...[{ kind: 'present' }, { kind: 'absent' }, { kind: 'equals', value: 'true' }].map((assertion) => ({
    name: `an expectStorage with ${assertion.kind} on a read entry`, step: expectStorage('privateKey', assertion),
  })),
];

for (const { name, step } of ACCEPTED_STEPS) {
  test(`${name} is accepted and kept as written`, { criterion: 'AC-SPEC-33-02' }, () => {
    const plan = accepted(parsePlan, planOf([OPEN_LOGIN, step]));
    assert.deepEqual(asJson(plan.steps[1]), step);
  });
}

test('a remember may read a response field as text or as an array length, for later steps to use', { criterion: 'AC-SPEC-33-02' }, () => {
  const steps = [
    OPEN_LOGIN, rememberResponse('likeCount', 'likes', 'likeList', 'arrayLength'), rememberResponse('firstName', 'likes', 'firstLiker', 'text'),
    { type: 'expect', locator: LIKE_COUNT, assert: { kind: 'textEquals', value: { valueName: 'likeCount' } }, criterionId: 'likes.count-shown' },
    expectResponse('likes', { kind: 'fieldEquals', field: 'firstLiker', value: { valueName: 'firstName' } }),
  ];
  const plan = accepted(parsePlan, planOf(steps));
  assert.deepEqual(asJson(plan.steps.slice(0, steps.length)), steps);
});

// Stubs started inside a frame or a second tab apply to the whole browser context.
test('a stub may be started and stopped inside a frame or a newTab', { criterion: 'AC-SPEC-33-02' }, () => {
  accepted(parsePlan, planOf([OPEN_LOGIN, frame([startStub('loginNeedsCode', LOGIN_ARGUMENTS), stopStub('loginNeedsCode')])]));
  accepted(parsePlan, planOf([OPEN_LOGIN, newTab([startStub('cartEmpty')])]));
});

// ---- Refused plans --------------------------------------------------------------------------------

type RefusedCase = { readonly name: string; readonly plan: JsonRecord; readonly code: PlanErrorCode; readonly path: string };

// One refused step after opening the page: its index is 1.
const refusedStep = (name: string, step: JsonRecord, code: PlanErrorCode, path: string): RefusedCase =>
  ({ name, plan: planOf([OPEN_LOGIN, step]), code, path: `$.steps[1]${path}` });

// Each case changes one thing in a step the parser accepts. Values from the plan are the private
// marker wherever a value, not a key, is wrong, so a test can see that no error echoes it.
const REFUSED: readonly RefusedCase[] = [
  // ---- Undeclared names ----
  refusedStep('a stub name that is not a declared stub', startStub(PRIVATE_MARKER), 'unknown_value', '.stub'),
  refusedStep('a well-formed stub name the project does not declare', startStub('checkoutFails'), 'unknown_value', '.stub'),
  refusedStep('a stop of an undeclared stub', stopStub('checkoutFails'), 'unknown_value', '.stub'),
  refusedStep('a stop of a declared stub the plan never started', stopStub('cartEmpty'), 'unknown_value', '.stub'),
  {
    name: 'a stop before the stub\'s only start', plan: planOf([OPEN_LOGIN, stopStub('cartEmpty'), startStub('cartEmpty')]),
    code: 'unknown_value', path: '$.steps[1].stub',
  },
  refusedStep('a resetRequests of an undeclared request', resetRequests(PRIVATE_MARKER), 'unknown_value', '.request'),
  refusedStep('an expectRequests of an undeclared request', expectRequests('avatarLoads', { atLeast: 1 }), 'unknown_value', '.request'),
  refusedStep('an expectResponse of an undeclared request', expectResponse(PRIVATE_MARKER, { kind: 'statusEquals', value: 200 }), 'unknown_value', '.request'),
  refusedStep('a remember from an undeclared response', rememberResponse('likeCount', PRIVATE_MARKER, 'likeList', 'arrayLength'), 'unknown_value', '.from.response'),
  refusedStep('a setStorage of an undeclared entry', setStorage(PRIVATE_MARKER), 'unknown_value', '.entry'),
  refusedStep('a removeStorage of an undeclared entry', removeStorage('authToken'), 'unknown_value', '.entry'),
  refusedStep('an expectStorage of an undeclared entry', expectStorage(PRIVATE_MARKER, { kind: 'present' }), 'unknown_value', '.entry'),
  refusedStep('an expectResponse of a field the request does not declare', expectResponse('likes', { kind: 'fieldEquals', field: PRIVATE_MARKER, value: 'Ada' }), 'unknown_value', '.assert.field'),
  refusedStep('a field check on a request that declares no fields', expectResponse('scheduleLoads', { kind: 'fieldPresent', field: 'likeList' }), 'unknown_value', '.assert.field'),
  refusedStep('a remember of a field the request does not declare', rememberResponse('likeCount', 'likes', PRIVATE_MARKER, 'text'), 'unknown_value', '.from.field'),
  // ---- Writing an entry declared read ----
  refusedStep('a setStorage of a read entry', setStorage('privateKey'), 'unknown_value', '.entry'),
  refusedStep('a removeStorage of a read entry', removeStorage('privateKey'), 'unknown_value', '.entry'),
  // ---- Arguments ----
  refusedStep('a missing stub argument', startStub('loginNeedsCode', {}), 'missing_field', '.arguments.reason'),
  refusedStep('a stub argument the declaration does not have', startStub('loginNeedsCode', { ...LOGIN_ARGUMENTS, status: 200 }), 'unknown_field', '.arguments.status'),
  refusedStep('a number for a text stub argument', startStub('loginNeedsCode', { reason: 42 }), 'wrong_type', '.arguments.reason'),
  refusedStep('a stub argument over its maximum length', startStub('loginNeedsCode', { reason: `${PRIVATE_MARKER}${'x'.repeat(80)}` }), 'too_long', '.arguments.reason'),
  {
    name: 'arguments on a stub stop',
    plan: planOf([OPEN_LOGIN, startStub('loginNeedsCode', LOGIN_ARGUMENTS), { ...stopStub('loginNeedsCode'), arguments: LOGIN_ARGUMENTS }]),
    code: 'unknown_field', path: '$.steps[2].arguments',
  },
  refusedStep('a missing storage argument', setStorage('pinnedMenu', {}), 'missing_field', '.arguments.docked'),
  refusedStep('text for a boolean storage argument', setStorage('pinnedMenu', { docked: PRIVATE_MARKER }), 'wrong_type', '.arguments.docked'),
  refusedStep('a storage argument the entry does not have', setStorage('welcomeDismissed', { value: PRIVATE_MARKER }), 'unknown_field', '.arguments.value'),
  refusedStep('a literal in a secret storage parameter', setStorage('sessionToken', { token: PRIVATE_MARKER }), 'literal_secret', '.arguments.token'),
  refusedStep('arguments on a removeStorage', { ...removeStorage('pinnedMenu'), arguments: { docked: true } }, 'unknown_field', '.arguments'),
  // ---- Kinds and actions the language does not have ----
  refusedStep('a stub action other than start or stop', { ...startStub('cartEmpty'), action: 'pause' }, 'unknown_value', '.action'),
  refusedStep('a response check kind the language does not have', expectResponse('likes', { kind: 'bodyMatches', value: 'Ada' }), 'unknown_value', '.assert.kind'),
  refusedStep('a storage check kind the language does not have', expectStorage('privateKey', { kind: 'contains', value: 'key' }), 'unknown_value', '.assert.kind'),
  refusedStep('a remember reading a response field as an input value', rememberResponse('likeCount', 'likes', 'likeList', 'value'), 'unknown_value', '.from.read'),
  refusedStep('a remember reading an element as an array length', { type: 'remember', name: 'likeCount', from: { element: LIKE_COUNT, read: 'arrayLength' } }, 'unknown_value', '.from.read'),
  // ---- Run values follow the run-value rules ----
  refusedStep('a field check against a value never defined', expectResponse('likes', { kind: 'fieldEquals', field: 'firstLiker', value: { valueName: 'neverSet' } }), 'undefined_value', '.assert.value'),
  // ---- Fields a plan may never write ----
  ...['request', 'responses', 'url', 'headers', 'body', 'status', 'mediaType', 'script'].map((field) =>
    refusedStep(`a stub step that sets its own ${field}`, { ...startStub('cartEmpty'), [field]: PRIVATE_MARKER }, 'unknown_field', `.${field}`)),
  ...['area', 'origin', 'key', 'value'].map((field) =>
    refusedStep(`a setStorage that sets its own ${field}`, { ...setStorage('welcomeDismissed'), [field]: PRIVATE_MARKER }, 'unknown_field', `.${field}`)),
  ...['url', 'method', 'path'].map((field) =>
    refusedStep(`an expectRequests that sets its own ${field}`, { ...expectRequests('likes', { atLeast: 1 }), [field]: PRIVATE_MARKER }, 'unknown_field', `.${field}`)),
  refusedStep('an expectResponse that sets its own pointer', { ...expectResponse('likes', { kind: 'fieldPresent', field: 'likeList' }), pointer: `/${PRIVATE_MARKER}` }, 'unknown_field', '.pointer'),
  refusedStep('an expectStorage that sets its own key', { ...expectStorage('privateKey', { kind: 'present' }), key: PRIVATE_MARKER }, 'unknown_field', '.key'),
];

for (const refused of REFUSED) {
  test(`${refused.name} is refused with ${refused.code} at ${refused.path}`, { criterion: 'AC-SPEC-33-02' }, () => {
    assert.deepEqual(rejection(parsePlan, refused.plan), [`${refused.code} ${refused.path}`]);
  });
}

test('no refusal echoes the value the plan wrote', { criterion: 'AC-SPEC-33-02' }, () => {
  const withMarker = REFUSED.filter((refused) => JSON.stringify(refused.plan).includes(PRIVATE_MARKER));
  assert.ok(withMarker.length >= 20, 'most cases carry the private marker');
  for (const refused of withMarker) {
    const parsed = parsePlan(refused.plan);
    assert.equal(parsed.ok, false, refused.name);
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), `${refused.name}: ${JSON.stringify(parsed)}`);
  }
});

// Parts whose code the spec leaves to the parser: each is still refused, and every error is at
// the part or inside it.
const assertRefusedInside = (errors: readonly string[], path: string, label: string): void => {
  assert.ok(errors.length > 0, label);
  for (const error of errors) {
    const found = error.split(' ')[1] ?? '';
    assert.ok(found === path || found.startsWith(`${path}.`), `${label}: ${JSON.stringify(errors)}`);
  }
};

test('a stub start with no arguments, for a stub that has parameters, is refused at its arguments', { criterion: 'AC-SPEC-33-02' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_LOGIN, startStub('loginNeedsCode')]));
  assertRefusedInside(errors, '$.steps[1].arguments', 'no arguments');
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['missing_field']);
});

test('a request count that is not a whole number is refused with wrong_type at the count', { criterion: 'AC-SPEC-33-02' }, () => {
  for (const [count, path] of [[{ atLeast: 1.5 }, 'atLeast'], [{ atMost: '1' }, 'atMost'], [{ equals: null }, 'equals']] as const) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_LOGIN, expectRequests('likes', count)])), [`wrong_type $.steps[1].count.${path}`], JSON.stringify(count));
  }
});

test('a request count that is negative, empty, of two kinds or of an unknown kind is refused at the count', { criterion: 'AC-SPEC-33-02' }, () => {
  for (const count of [{ equals: -1 }, {}, { equals: 1, atMost: 2 }, { exactly: 2 }, 2]) {
    assertRefusedInside(rejection(parsePlan, planOf([OPEN_LOGIN, expectRequests('likes', count)])), '$.steps[1].count', JSON.stringify(count));
  }
});

test('a request count of atLeast 0, which any page passes, is refused as vacuous', { criterion: 'AC-SPEC-33-02' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_LOGIN, expectRequests('likes', { atLeast: 0 })]));
  assertRefusedInside(errors, '$.steps[1]', 'atLeast 0');
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['vacuous']);
});

// Counter-example: equals 0 says something (no request was sent), so it is accepted; atLeast 1 too.
test('a request count of equals 0 or atLeast 1 is accepted', { criterion: 'AC-SPEC-33-02' }, () => {
  for (const count of [{ equals: 0 }, { atLeast: 1 }, { atMost: 0 }]) accepted(parsePlan, planOf([OPEN_LOGIN, expectRequests('likes', count)]));
});

test('a statusEquals value that is not a whole number is refused with wrong_type at the value', { criterion: 'AC-SPEC-33-02' }, () => {
  for (const value of ['200', null, 200.5]) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_LOGIN, expectResponse('likes', { kind: 'statusEquals', value })])), ['wrong_type $.steps[1].assert.value'], JSON.stringify(value));
  }
});

test('a statusEquals value that is a run value is refused at the value', { criterion: 'AC-SPEC-33-02' }, () => {
  const values = { expectedStatus: { kind: 'uniqueNumber', digits: 4 } };
  assertRefusedInside(rejection(parsePlan, planOf([OPEN_LOGIN, expectResponse('likes', { kind: 'statusEquals', value: { valueName: 'expectedStatus' } })], { values })), '$.steps[1].assert.value', 'run value');
});

test('a stub started, stopped and started again is accepted', { criterion: 'AC-SPEC-33-02' }, () => {
  accepted(parsePlan, planOf([OPEN_LOGIN, startStub('cartEmpty'), stopStub('cartEmpty'), startStub('cartEmpty'), stopStub('cartEmpty')]));
});

test('a storage or response value that names a secret is refused at the value', { criterion: 'AC-SPEC-33-02' }, () => {
  const secret = { secretName: TOKEN_SECRET };
  assertRefusedInside(rejection(parsePlan, planOf([OPEN_LOGIN, expectStorage('sessionToken', { kind: 'equals', value: secret })])), '$.steps[1].assert.value', 'storage');
  assertRefusedInside(rejection(parsePlan, planOf([OPEN_LOGIN, expectResponse('likes', { kind: 'fieldEquals', field: 'firstLiker', value: secret })])), '$.steps[1].assert.value', 'response');
});

test('a secret storage parameter given an undeclared secret or a run value is refused at the argument', { criterion: 'AC-SPEC-33-02' }, () => {
  const values = { visitor: { kind: 'uniqueText', prefix: 'visitor' } };
  for (const token of [{ secretName: 'PRODUCTION_DATABASE_URL' }, { valueName: 'visitor' }]) {
    assertRefusedInside(rejection(parsePlan, planOf([OPEN_LOGIN, setStorage('sessionToken', { token })], { values })), '$.steps[1].arguments.token', JSON.stringify(token));
  }
});

test('a response value remembered under the name of a generated value is refused as duplicate', { criterion: 'AC-SPEC-33-02' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_LOGIN, rememberResponse('likeCount', 'likes', 'likeList', 'arrayLength')], {
    values: { likeCount: { kind: 'uniqueNumber', digits: 4 } },
  }));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

test('an assertion step of this spec without a criterion id is refused', { criterion: 'AC-SPEC-33-02' }, () => {
  for (const step of [expectRequests('likes', { atLeast: 1 }), expectResponse('likes', { kind: 'statusEquals', value: 200 }), expectStorage('privateKey', { kind: 'present' })]) {
    const { criterionId: _removed, ...untraced } = step;
    const errors = rejection(parsePlan, planOf([OPEN_LOGIN, untraced]));
    assertRefusedInside(errors, '$.steps[1]', String(step['type']));
  }
});

// ---- Version 1.1 ----------------------------------------------------------------------------------

test('a plan declaring 1.1 that uses any step of this spec is refused with unknown_step, as a 1.1 parser refuses it', { criterion: 'AC-SPEC-33-02' }, () => {
  const parse = defaultParser();
  assert.equal(signupPlan()['version'], PREVIOUS_VERSION);
  const previousWith = (added: JsonRecord): JsonRecord => {
    const steps = [...stepsOf(signupPlan())];
    steps.splice(1, 0, added);
    return { ...signupPlan(), steps };
  };
  for (const step of [
    startStub('cartEmpty'), stopStub('cartEmpty'), resetRequests('likes'), expectRequests('likes', { atLeast: 1 }),
    expectResponse('likes', { kind: 'statusEquals', value: 200 }), rememberResponse('likeCount', 'likes', 'likeList', 'arrayLength'),
    setStorage('pinnedMenu', { docked: true }), removeStorage('pinnedMenu'), expectStorage('privateKey', { kind: 'present' }),
  ]) {
    assert.deepEqual(rejection(parse, previousWith(step)), ['unknown_step $.steps[1].type'], String(step['type']));
  }
});

// ---- No driver call for a refused plan ---------------------------------------------------------------

test('a refused plan reaches no driver method, and nothing is logged', { criterion: 'AC-SPEC-33-02' }, async () => {
  let driverCalls = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { driverCalls++; return { ok: true, value: true }; },
    async open() { driverCalls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const events = memoryRunEventSink();
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events };
  const base = { project: stubProject(), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  for (const refused of REFUSED) {
    const outcome = await runUntrusted(refused.plan, parsePlan, base, ports);
    assert.ok('errors' in outcome, `${refused.name}: ${JSON.stringify(outcome)}`);
  }
  assert.equal(driverCalls, 0, 'no driver method was called');
  assert.equal(events.read().length, 0, 'nothing was logged');
});

// Counter-example: an accepted plan with a stub does reach the driver, so the spy above can fail.
test('counter-example: an accepted plan with a stub step does reach the driver', { criterion: 'AC-SPEC-33-02' }, async () => {
  let opens = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { return { ok: true, value: true }; },
    async open() { opens++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events: memoryRunEventSink() };
  const base = { project: stubProject(), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  await runUntrusted(planOf([OPEN_LOGIN, startStub('cartEmpty')]), parsePlan, base, ports);
  assert.equal(opens, 1);
});
