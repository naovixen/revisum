// Declared calls in a run, against a fake ServiceCaller in place of runner's (which, with the
// egress proxy, comes with SPEC-07). The engine builds each request, judges its status against the
// declaration, reads response fields, polls backend checks and runs cleanup:
//   - a failed `call` ends the run Errored, skips the later steps, and cleanup still runs;
//   - a failed `expectBackend` ends it Failed; read checks are polled until they pass or
//     backendCheckTimeoutMilliseconds runs out, and a write is never sent twice;
//   - cleanup runs in order whatever the outcome: a call needing a value never set is skipped,
//     and a failing one is recorded cleanup-failed without changing the verdict;
//   - secrets are resolved before any call, and no secret, header value or response body reaches
//     the result or the log, which holds only the logging manifest's fields.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOGGING_MANIFEST, leakScanner, type ServiceRequest } from '@revisum/engine';
import { echoesIn, fakeSecretValue, resolvedSecret } from './secret-examples.ts';
import {
  ADMIN_LOGIN_SECRET, ADMIN_PASSWORD_SECRET, CREATE_ORDER, DELETE_ORDER, HEADER_MARKER, ORDER_ID, RESET_SHOP, SECRET_VALUES, TOKEN_SECRET,
  call, callPlanOf, callProjectFile, cleanupRecords, emptyReply, expectBackend, failedReply, jsonReply, orderArguments, requestLine,
  reviewItemCodes, runWithCalls, shopWith, stepLines, textReply, withCleanup, type JsonRecord, type Reply,
} from './service-call-examples.ts';

const ORDER_PAID = expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, 'status', { kind: 'equals', value: 'paid' });
const NAVIGATE: JsonRecord = { type: 'navigate', url: '/orders' };
const lines = (requests: readonly ServiceRequest[]): string[] => requests.map(requestLine);
const sentTo = (requests: readonly ServiceRequest[], line: string): number => lines(requests).filter((sent) => sent === line).length;

// The shop, but creating an order answers `reply`.
const orderCreationAnswers = (reply: Reply) => shopWith((request) => (requestLine(request) === 'POST /api/orders' ? reply : undefined));

// ---- Run-time type checks --------------------------------------------------------------------------

test('a generated value that fails its parameter\'s type fails the call with parameter-invalid, sending nothing', { criterion: 'AC-SPEC-32-04' }, async () => {
  // A unique text is "order-<unique part>": its hyphen is not allowed in an identifier.
  const values = { orderCode: { kind: 'uniqueText', prefix: 'order' } };
  const ran = await runWithCalls(callPlanOf([call('getOrder', { orderId: { valueName: 'orderCode' } }), NAVIGATE], { values }));
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['call failed parameter-invalid', 'navigate skipped']);
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(lines(ran.requests), [], 'no request was sent');
});

test('a remembered value that fails the next call\'s type fails that call with parameter-invalid', { criterion: 'AC-SPEC-32-04' }, async () => {
  const hostileId = shopWith((request) => (requestLine(request) === 'POST /api/orders' ? jsonReply(201, { id: "17'; DROP TABLE orders; --", status: 'pending' }) : undefined));
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, call('getOrder', { orderId: { valueName: 'orderId' } })]), { route: hostileId });
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['call passed', 'call failed parameter-invalid']);
  assert.deepEqual(lines(ran.requests), ['POST /api/orders'], 'only the first call was sent');
});

// Counter-example: the same plan, when the shop gives an identifier, sends both calls.
test('a remembered identifier reaches the next call\'s path', { criterion: 'AC-SPEC-32-04' }, async () => {
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, call('getOrder', { orderId: { valueName: 'orderId' } })]));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.deepEqual(lines(ran.requests), ['POST /api/orders', `GET /api/orders/${ORDER_ID}`]);
});

// ---- A call that fails -------------------------------------------------------------------------------

const FAILED_CALLS: readonly { readonly name: string; readonly reply: Reply; readonly code: string }[] = [
  { name: 'a status outside successStatuses', reply: jsonReply(500, { error: 'database down' }), code: 'unexpected-status' },
  { name: 'a success status of another kind (200 where 201 is declared)', reply: jsonReply(200, { id: ORDER_ID }), code: 'unexpected-status' },
  { name: 'a redirect', reply: emptyReply(302), code: 'unexpected-status' },
  { name: 'a timeout', reply: failedReply('call-timeout'), code: 'call-timeout' },
  { name: 'a refused connection', reply: failedReply('service-unreachable'), code: 'service-unreachable' },
];

for (const failed of FAILED_CALLS) {
  test(`a call that gets ${failed.name} ends the run Errored with ${failed.code}, skipping later steps`, { criterion: 'AC-SPEC-32-07' }, async () => {
    const ran = await runWithCalls(withCleanup(callPlanOf([NAVIGATE, CREATE_ORDER, NAVIGATE]), [RESET_SHOP]), { route: orderCreationAnswers(failed.reply) });
    assert.equal(ran.result.state, 'Errored');
    assert.deepEqual(stepLines(ran.result), ['navigate passed', `call failed ${failed.code}`, 'navigate skipped', 'expect skipped']);
    assert.deepEqual(ran.recording.navigations.length, 1, 'no step after the failed call reached the page');
  });

  test(`after a call that gets ${failed.name}, cleanup still runs`, { criterion: 'AC-SPEC-32-07' }, async () => {
    const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER]), [RESET_SHOP]), { route: orderCreationAnswers(failed.reply) });
    assert.deepEqual(lines(ran.requests), ['POST /api/orders', 'POST /api/test/reset']);
    assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['passed']);
  });
}

// Counter-example: the declared status passes, and the run goes on.
test('a call that gets a declared success status passes, and the steps after it run', { criterion: 'AC-SPEC-32-07' }, async () => {
  const ran = await runWithCalls(callPlanOf([NAVIGATE, CREATE_ORDER, NAVIGATE]));
  assert.equal(ran.result.state, 'Passed');
  assert.deepEqual(stepLines(ran.result), ['navigate passed', 'call passed', 'navigate passed', 'expect passed']);
});

test('a status the declaration lists as success, such as 404 for deleteOrder, passes', { criterion: 'AC-SPEC-32-07' }, async () => {
  const gone = shopWith((request) => (request.method === 'DELETE' ? emptyReply(404) : undefined));
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, DELETE_ORDER]), { route: gone });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
});

// The real caller never follows a redirect (with SPEC-07); the engine judges the redirect's own
// status against the declaration, like any other status.
test('a redirect status is judged against successStatuses: undeclared it fails, declared it passes', { criterion: 'AC-SPEC-32-05' }, async () => {
  const redirecting = shopWith((request) => (requestLine(request) === 'POST /api/test/reset' ? emptyReply(303) : undefined));
  const undeclared = await runWithCalls(callPlanOf([RESET_SHOP]), { route: redirecting });
  assert.deepEqual(stepLines(undeclared.result).slice(0, 1), ['call failed unexpected-status']);
  assert.equal(sentTo(undeclared.requests, 'POST /api/test/reset'), 1, 'the redirect was followed or retried');
  const declaredProject = callProjectFile({
    resetShop: {
      service: 'shop', method: 'POST', path: '/api/test/reset', headers: { authorization: { secretName: ADMIN_LOGIN_SECRET, scheme: 'basic' } },
      parameters: {}, effect: 'write', successStatuses: [204, 303], allowInProposals: true,
    },
  });
  const declared = await runWithCalls(callPlanOf([RESET_SHOP]), { route: redirecting, projectFile: declaredProject });
  assert.equal(declared.result.state, 'Passed', JSON.stringify(declared.result.steps));
  assert.deepEqual(lines(declared.requests), ['POST /api/test/reset']);
});

// ---- Cleanup -------------------------------------------------------------------------------------------

const CLEANUP = [DELETE_ORDER, RESET_SHOP];
const CLEANUP_LINES = [`DELETE /api/orders/${ORDER_ID}`, 'POST /api/test/reset'];

test('when the run passes, its cleanup calls run in order after the steps', { criterion: 'AC-SPEC-32-08' }, async () => {
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), CLEANUP));
  assert.equal(ran.result.state, 'Passed');
  assert.deepEqual(lines(ran.requests), ['POST /api/orders', `GET /api/orders/${ORDER_ID}`, ...CLEANUP_LINES]);
  assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['passed', 'passed']);
});

test('when the run fails, its cleanup calls still run in order', { criterion: 'AC-SPEC-32-08' }, async () => {
  const pending = shopWith((request) => (request.method === 'GET' ? jsonReply(200, { status: 'pending', total: 42 }) : undefined));
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), CLEANUP), { route: pending });
  assert.equal(ran.result.state, 'Failed');
  assert.deepEqual(lines(ran.requests).slice(-2), CLEANUP_LINES);
});

test('when the run errors after the value is set, its cleanup calls still run in order', { criterion: 'AC-SPEC-32-08' }, async () => {
  const brokenRead = shopWith((request) => (request.method === 'GET' ? failedReply('service-unreachable') : undefined));
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER, call('getOrder', { orderId: { valueName: 'orderId' } })]), CLEANUP), { route: brokenRead });
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(lines(ran.requests).slice(-2), CLEANUP_LINES);
});

test('a cleanup call needing a value never set, because the run stopped first, is recorded skipped and not sent', { criterion: 'AC-SPEC-32-08' }, async () => {
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER]), CLEANUP), { route: orderCreationAnswers(jsonReply(500, {})) });
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['skipped', 'passed']);
  assert.equal(sentTo(ran.requests, `DELETE /api/orders/${ORDER_ID}`), 0, 'the skipped cleanup call was sent');
  assert.equal(sentTo(ran.requests, 'POST /api/test/reset'), 1, 'the cleanup call after it still ran');
});

const failingReset = shopWith((request) => (requestLine(request) === 'POST /api/test/reset' ? jsonReply(500, {}) : undefined));

test('a failing cleanup call is recorded cleanup-failed, and the passing verdict does not change', { criterion: 'AC-SPEC-32-08' }, async () => {
  const plan = withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), CLEANUP);
  const failing = await runWithCalls(plan, { route: failingReset });
  const succeeding = await runWithCalls(plan);
  assert.deepEqual(cleanupRecords(failing.result), [{ outcome: 'passed' }, { outcome: 'failed', code: 'cleanup-failed' }]);
  assert.equal(failing.result.state, 'Passed');
  assert.equal(failing.result.state, succeeding.result.state);
  assert.deepEqual(stepLines(failing.result), stepLines(succeeding.result));
});

test('a failing cleanup call does not change a failing verdict either', { criterion: 'AC-SPEC-32-08' }, async () => {
  const pendingAndFailingReset = shopWith((request, earlier) => {
    if (request.method === 'GET') return jsonReply(200, { status: 'pending', total: 42 });
    return failingReset(request, earlier);
  });
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), [RESET_SHOP]), { route: pendingAndFailingReset });
  assert.equal(ran.result.state, 'Failed');
  assert.deepEqual(cleanupRecords(ran.result), [{ outcome: 'failed', code: 'cleanup-failed' }]);
});

test('a failing cleanup call raises a review item; a clean cleanup raises none', { criterion: 'AC-SPEC-32-08' }, async () => {
  const plan = withCleanup(callPlanOf([CREATE_ORDER]), CLEANUP);
  assert.deepEqual(reviewItemCodes((await runWithCalls(plan, { route: failingReset })).result), ['cleanup-failed']);
  assert.deepEqual(reviewItemCodes((await runWithCalls(plan)).result), []);
});

test('a failing cleanup call does not stop the cleanup calls after it', { criterion: 'AC-SPEC-32-08' }, async () => {
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER]), [RESET_SHOP, DELETE_ORDER]), { route: failingReset });
  assert.deepEqual(lines(ran.requests), ['POST /api/orders', 'POST /api/test/reset', `DELETE /api/orders/${ORDER_ID}`]);
});

// ---- Backend checks poll; writes are sent once ------------------------------------------------------------

const BACKEND_CHECK_TIMEOUT = 2000;
const shortChecks = callProjectFile({}, { backendCheckTimeoutMilliseconds: BACKEND_CHECK_TIMEOUT });

test('an expectBackend whose field matches only on the third poll passes', { criterion: 'AC-SPEC-32-09' }, async () => {
  const paidOnThirdRead = shopWith((request, earlier) => {
    if (request.method !== 'GET') return undefined;
    const readsBefore = earlier.filter((sent) => sent.method === 'GET').length;
    return jsonReply(200, { status: readsBefore >= 2 ? 'paid' : 'pending', total: 42 });
  });
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, ORDER_PAID]), { route: paidOnThirdRead, projectFile: shortChecks });
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['call passed', 'expectBackend passed']);
  assert.equal(ran.result.state, 'Passed');
  assert.equal(sentTo(ran.requests, `GET /api/orders/${ORDER_ID}`), 3);
  assert.ok(ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT, `the check waited ${ran.clock.elapsed()} ms`);
});

test('an expectBackend whose field never matches fails with assertion-failed once the check timeout runs out', { criterion: 'AC-SPEC-32-09' }, async () => {
  const neverPaid = shopWith((request) => (request.method === 'GET' ? jsonReply(200, { status: 'pending', total: 42 }) : undefined));
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, ORDER_PAID]), { route: neverPaid, projectFile: shortChecks });
  assert.deepEqual(stepLines(ran.result).slice(0, 3), ['call passed', 'expectBackend failed assertion-failed', 'expect skipped']);
  assert.equal(ran.result.state, 'Failed');
  assert.ok(ran.clock.elapsed() >= BACKEND_CHECK_TIMEOUT, `the check gave up after ${ran.clock.elapsed()} ms`);
  assert.ok(ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT * 2, `the check kept polling for ${ran.clock.elapsed()} ms`);
  assert.ok(sentTo(ran.requests, `GET /api/orders/${ORDER_ID}`) > 1, 'the read was polled');
});

test('each backend assertion kind passes on a matching field and fails on another', { criterion: 'AC-SPEC-32-09' }, async () => {
  const cases: readonly [string, JsonRecord, boolean][] = [
    ['status', { kind: 'equals', value: 'paid' }, true], ['status', { kind: 'equals', value: 'Paid' }, false],
    ['status', { kind: 'contains', value: 'ai' }, true], ['status', { kind: 'contains', value: 'due' }, false],
    ['total', { kind: 'numberEquals', value: 42 }, true], ['total', { kind: 'numberEquals', value: 41 }, false],
    ['status', { kind: 'present' }, true], ['status', { kind: 'absent' }, false],
  ];
  for (const [field, assertion, passes] of cases) {
    const ran = await runWithCalls(callPlanOf([CREATE_ORDER, expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, field, assertion)]), { projectFile: shortChecks });
    assert.equal(ran.result.state, passes ? 'Passed' : 'Failed', `${field} ${JSON.stringify(assertion)}`);
  }
});

for (const [name, reply] of [['times out', failedReply('call-timeout')], ['gets an unexpected status', jsonReply(503, {})]] as const) {
  test(`a write call that ${name} is sent exactly once`, { criterion: 'AC-SPEC-32-09' }, async () => {
    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), { route: orderCreationAnswers(reply), projectFile: shortChecks });
    assert.equal(ran.result.state, 'Errored');
    assert.equal(sentTo(ran.requests, 'POST /api/orders'), 1);
  });
}

// ---- Reading the response -------------------------------------------------------------------------------

for (const [name, reply, code] of [
  ['larger than its cap', failedReply('response-too-large'), 'response-too-large'],
  ['an HTML page', textReply(201, 'text/html', '<html><body>Created</body></html>'), 'response-not-json'],
  ['labelled JSON but not JSON', textReply(201, 'application/json', '{"id": "ord_1042",'), 'response-not-json'],
  ['JSON without the remembered field', jsonReply(201, { status: 'pending' }), 'field-missing'],
] as const) {
  test(`a call whose response is ${name} fails with ${code}`, { criterion: 'AC-SPEC-32-10' }, async () => {
    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), { route: orderCreationAnswers(reply) });
    assert.deepEqual(stepLines(ran.result).slice(0, 1), [`call failed ${code}`]);
  });
}

test('a call that remembers nothing passes on a non-JSON response with a declared status', { criterion: 'AC-SPEC-32-10' }, async () => {
  const htmlReset = shopWith((request) => (requestLine(request) === 'POST /api/test/reset' ? textReply(204, 'text/html', '') : undefined));
  const ran = await runWithCalls(callPlanOf([RESET_SHOP]), { route: htmlReset });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
});

// ---- Secrets -----------------------------------------------------------------------------------------------

test('a header secret the store cannot resolve ends the run before any call or page, with secret-missing', { criterion: 'AC-SPEC-32-12' }, async () => {
  const environment = { [ADMIN_LOGIN_SECRET]: SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '', [ADMIN_PASSWORD_SECRET]: SECRET_VALUES[ADMIN_PASSWORD_SECRET] ?? '' };
  const ran = await runWithCalls(withCleanup(callPlanOf([NAVIGATE, CREATE_ORDER]), [RESET_SHOP]), { environment });
  assert.equal(ran.result.state, 'Refused');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(ran.result.refusal).includes(TOKEN_SECRET), `the refusal names the secret: ${JSON.stringify(ran.result.refusal)}`);
  assert.deepEqual(lines(ran.requests), [], 'no call was made, cleanup included');
  assert.equal(ran.recording.environments.length, 0, 'no browser session was opened');
  for (const value of Object.values(environment)) assert.deepEqual(echoesIn(ran.everything, value), [], 'a resolvable secret was echoed');
});

test('a secret argument or a cleanup call\'s secret that cannot be resolved ends the run before any call', { criterion: 'AC-SPEC-32-12' }, async () => {
  const withoutPassword = { [TOKEN_SECRET]: SECRET_VALUES[TOKEN_SECRET] ?? '', [ADMIN_LOGIN_SECRET]: SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '' };
  const signIn = call('signInAsAdmin', { adminPassword: { secretName: ADMIN_PASSWORD_SECRET } });
  const byArgument = await runWithCalls(callPlanOf([CREATE_ORDER, signIn]), { environment: withoutPassword });
  assert.equal(byArgument.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(byArgument.result.refusal).includes(ADMIN_PASSWORD_SECRET));
  const withoutLogin = { [TOKEN_SECRET]: SECRET_VALUES[TOKEN_SECRET] ?? '', [ADMIN_PASSWORD_SECRET]: SECRET_VALUES[ADMIN_PASSWORD_SECRET] ?? '' };
  const byCleanup = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER]), [RESET_SHOP]), { environment: withoutLogin });
  assert.equal(byCleanup.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(byCleanup.result.refusal).includes(ADMIN_LOGIN_SECRET));
  assert.deepEqual([...lines(byArgument.requests), ...lines(byCleanup.requests)], [], 'no call was made');
});

// Counter-example: with every secret resolvable, the same plans make their calls.
test('control: when every secret resolves, the calls are made', { criterion: 'AC-SPEC-32-12' }, async () => {
  const ran = await runWithCalls(withCleanup(callPlanOf([CREATE_ORDER, call('signInAsAdmin', { adminPassword: { secretName: ADMIN_PASSWORD_SECRET } })]), [RESET_SHOP]));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result));
  assert.deepEqual(lines(ran.requests), ['POST /api/orders', 'POST /api/test/sessions', 'POST /api/test/reset']);
});

// ---- No echo of a secret, a header or a response --------------------------------------------------------------

const RESPONSE_MARKER = 'response-body-q7zx';
const basicForm = (value: string): string => Buffer.from(value).toString('base64');

// A careless shop echoes every secret it was sent, in raw, base64 and URI forms, and a marker of its own.
const echoingShop = shopWith((request) => {
  const echoes = Object.values(SECRET_VALUES).flatMap((value) => [value, basicForm(value), encodeURIComponent(value)]);
  const body = { id: ORDER_ID, status: 'pending', total: 42, echo: { token: SECRET_VALUES[TOKEN_SECRET], all: echoes }, note: RESPONSE_MARKER };
  if (request.method === 'GET') return jsonReply(200, body);
  if (requestLine(request) === 'POST /api/orders') return jsonReply(201, body);
  return undefined;
});

// Creates an order, then checks a field that echoes the token against a text it can never equal,
// so the failed check keeps what it observed; cleanup resets the shop with the basic scheme.
const echoPlan = withCleanup(callPlanOf([
  CREATE_ORDER, expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, 'echoedToken', { kind: 'equals', value: 'deliberately wrong' }),
]), [RESET_SHOP]);

test('the result and log of a run whose responses echo its secrets hold no form of any secret', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runWithCalls(echoPlan, { route: echoingShop, projectFile: shortChecks });
  assert.equal(ran.result.state, 'Failed', 'the echo check failed, so the run kept what it observed');
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    assert.deepEqual(echoesIn(ran.everything, value), [], `${name} was echoed`);
    assert.ok(!ran.everything.includes(basicForm(value)), `${name} was echoed in its basic form`);
  }
});

test('the leak scan finds no secret in the run\'s result and log, and does find a planted canary', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runWithCalls(echoPlan, { route: echoingShop, projectFile: shortChecks });
  const folder = mkdtempSync(join(tmpdir(), 'service-leaks-'));
  try {
    const canaryValue = fakeSecretValue();
    const resultFile = join(folder, 'result.json');
    const eventsFile = join(folder, 'events.json');
    const canaryFile = join(folder, 'canary.txt');
    writeFileSync(resultFile, JSON.stringify(ran.result));
    writeFileSync(eventsFile, JSON.stringify(ran.events));
    writeFileSync(canaryFile, canaryValue);
    const files = [resultFile, eventsFile, canaryFile];
    const secrets = [
      ...Object.entries(SECRET_VALUES).map(([name, value]) => resolvedSecret(name, value)),
      resolvedSecret('LEAK_SCAN_CANARY', canaryValue),
    ];
    const leaks = leakScanner().scan(files, secrets);
    assert.deepEqual(leaks.filter((leak) => leak.secret !== 'LEAK_SCAN_CANARY'), [], 'a secret leaked into the result or log');
    assert.ok(leaks.some((leak) => leak.secret === 'LEAK_SCAN_CANARY'), 'the scan did not see the canary');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('no header value and no response body is recorded in the result or the log', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runWithCalls(echoPlan, { route: echoingShop, projectFile: shortChecks });
  assert.ok(!ran.everything.includes(HEADER_MARKER), 'a literal header value was recorded');
  assert.ok(!ran.everything.includes(RESPONSE_MARKER), 'response body text was recorded');
  assert.ok(!ran.everything.toLowerCase().includes('bearer '), 'an authorization header was recorded');
});

// ---- Evidence --------------------------------------------------------------------------------------------------

test('a run with calls lists service-calls among its non-hermetic inputs', { criterion: 'AC-SPEC-32-13' }, async () => {
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER]));
  assert.ok(ran.result.manifest?.nonHermeticInputs.includes('service-calls'), JSON.stringify(ran.result.manifest));
});

test('a run with only cleanup calls lists service-calls too, and a run without calls does not', { criterion: 'AC-SPEC-32-13' }, async () => {
  const cleanupOnly = await runWithCalls(withCleanup(callPlanOf([NAVIGATE]), [RESET_SHOP]));
  assert.ok(cleanupOnly.result.manifest?.nonHermeticInputs.includes('service-calls'), JSON.stringify(cleanupOnly.result.manifest));
  const noCalls = await runWithCalls(callPlanOf([NAVIGATE]));
  assert.ok(noCalls.result.manifest !== null);
  assert.ok(!noCalls.result.manifest.nonHermeticInputs.includes('service-calls'));
});

test('the same run with calls, repeated, gives the same result hash', { criterion: 'AC-SPEC-32-13' }, async () => {
  const plan = withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), CLEANUP);
  const hashes = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) hashes.add((await runWithCalls(plan)).result.resultHash);
  assert.equal(hashes.size, 1);
});

// ---- The log holds only manifest fields -------------------------------------------------------------------------

test('every event of a run with calls holds only fields the logging manifest lists', { criterion: 'AC-SPEC-32-16' }, async () => {
  const ran = await runWithCalls(echoPlan, { route: echoingShop, projectFile: shortChecks });
  const allowed = new Set(Object.keys(LOGGING_MANIFEST));
  const unlisted = ran.events.flatMap((event) => Object.keys(event).filter((key) => !allowed.has(key)).map((key) => `${event.kind}: ${key}`));
  assert.deepEqual(unlisted, []);
  // The calls were logged, so the check above saw call events.
  assert.ok(ran.events.some((event) => event.stepType === 'call'), JSON.stringify(ran.events));
  assert.ok(ran.events.some((event) => event.stepType === 'expectBackend'), JSON.stringify(ran.events));
});

test('the events of a call record neither arguments, headers nor the response, only codes, hashes and timings', { criterion: 'AC-SPEC-32-16' }, async () => {
  const marked = callPlanOf([call('createOrder', orderArguments({ customerName: 'Grace argument-q7zx' })), RESET_SHOP]);
  const ran = await runWithCalls(marked, { route: echoingShop });
  const logged = JSON.stringify(ran.events);
  for (const hidden of ['argument-q7zx', HEADER_MARKER, RESPONSE_MARKER, ...Object.values(SECRET_VALUES)]) {
    assert.ok(!logged.includes(hidden), `the log holds ${hidden.slice(0, 12)}`);
  }
});

// ---- A run with no service caller ----------------------------------------------------------------------------

test('a plan that calls a service, run with no services port, is refused with services-unavailable before any side effect', { criterion: 'AC-SPEC-32-07' }, async () => {
  for (const plan of [callPlanOf([NAVIGATE, CREATE_ORDER]), withCleanup(callPlanOf([NAVIGATE]), [RESET_SHOP]), callPlanOf([NAVIGATE, expectBackend('getOrder', { orderId: 'ord_1' }, 'status', { kind: 'present' })])]) {
    const ran = await runWithCalls(plan, { withCaller: false });
    assert.equal(ran.result.state, 'Refused', JSON.stringify(ran.result));
    assert.equal(ran.result.refusal?.code, 'services-unavailable');
    assert.deepEqual(ran.result.steps, [], 'no step ran');
    assert.equal(ran.recording.environments.length, 0, 'no browser session was opened');
    assert.equal(ran.recording.navigations.length, 0, 'nothing reached the page');
  }
});

// Counter-example: a plan that calls nothing needs no services port.
test('a plan that calls no service runs without a services port', { criterion: 'AC-SPEC-32-07' }, async () => {
  const ran = await runWithCalls(callPlanOf([NAVIGATE]), { withCaller: false });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result));
  assert.equal(ran.result.refusal, undefined);
});

// ---- The call limit counts steps, not polls ---------------------------------------------------------------------

test('an expectBackend polled three times counts once toward maximumCalls, so the run is not cut short', { criterion: 'AC-SPEC-32-06' }, async () => {
  const paidOnThirdRead = shopWith((request, earlier) => {
    if (request.method !== 'GET') return undefined;
    return jsonReply(200, { status: earlier.filter((sent) => sent.method === 'GET').length >= 2 ? 'paid' : 'pending', total: 42 });
  });
  const projectFile = callProjectFile({}, { maximumCalls: 2, backendCheckTimeoutMilliseconds: 2000 });
  const ran = await runWithCalls(callPlanOf([CREATE_ORDER, ORDER_PAID]), { route: paidOnThirdRead, projectFile });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.equal(ran.requests.length, 4, 'one create and three polls were sent, beyond a limit of 2 requests');
});
