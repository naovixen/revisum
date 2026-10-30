// Whole runs whose declared calls go through runner's real service caller and the in-process egress
// proxy to a local shop service on node:http, in place of the fake caller the engine's own tests
// use (test/unit/engine/service-call-runs.test.ts). They show the run-time behaviour end to end:
//   - a call the proxy refuses ends the run Errored with egress-blocked, and a redirect is judged
//     against successStatuses, never followed;
//   - a call that gets an undeclared status, times out or cannot connect ends the run Errored with
//     the matching code, later steps are skipped and cleanup still runs;
//   - a backend check polls the real service until its field matches, and a write that times out
//     reached the service exactly once;
//   - an oversized, non-JSON or incomplete response fails the step with its reading code;
//   - secrets reach the service, yet no form of any secret and no header value reaches the result,
//     the log, the proxy's decisions or the console, even when the service echoes them back.
// The project declares the shop at SHOP_ORIGIN (loopback port 4180); the proxy's connect function
// sends that port to the local shop, whatever port it really listens on, and every other port to a
// port where nothing listens.
// See docs/specs/SPEC-32-declared-service-calls.md, "The real caller".
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { leakScanner } from '@revisum/engine';
import { startEgressProxy, type EgressProxy } from '@revisum/runner';
import {
  ADMIN_LOGIN_SECRET, ADMIN_PASSWORD_SECRET, CALLS, CREATE_ORDER, HEADER_MARKER, ORDER_ID, RESET_SHOP, SECRET_VALUES, SHOP, SHOP_ORIGIN, SHOP_SERVICE,
  TOKEN_SECRET, call, callPlanOf, callProjectFile, cleanupRecords, expectBackend, runWithCalls, stepLines, withCleanup, type CallRun, type JsonRecord,
} from '../engine/service-call-examples.ts';
import { echoesIn, fakeSecretValue, resolvedSecret } from '../engine/secret-examples.ts';
import { closedPort, consoleWrittenDuring, realCaller, settle, startLocalService, type Answer, type LocalService, type ReceivedRequest } from './local-service.ts';
import { declaredService, egressPolicy } from './runner-examples.ts';

// ---- The local shop ------------------------------------------------------------------------------------

// A second declared service, on a port where nothing listens, for a call that cannot connect.
const STOPPED_SERVICE = 'warehouse';
const STOPPED_ORIGIN = 'http://127.0.0.1:4181';
const STOPPED: JsonRecord = { name: STOPPED_SERVICE, origin: STOPPED_ORIGIN, private: true };
const SHOP_PORT = Number(new URL(SHOP_ORIGIN).port);

const json = (response: Parameters<Answer>[1], status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

// Answers a request in place of the shop, or gives false to let the shop answer.
type ShopOverride = (received: ReceivedRequest, response: Parameters<Answer>[1], earlier: readonly ReceivedRequest[]) => boolean;

const lineOf = (received: ReceivedRequest): string => `${received.method} ${received.path}`;

// The shop, as the fake caller's SHOP_ROUTE answers: an order is created, read back as paid and
// deleted; the test data is reset; an administrator session opens.
const shopAnswer = (override: ShopOverride | undefined): Answer => (received, response, earlier) => {
  if (override?.(received, response, earlier) === true) return;
  const line = lineOf(received);
  if (line === 'POST /api/orders') json(response, 201, { id: ORDER_ID, status: 'pending' });
  else if (line === `GET /api/orders/${ORDER_ID}`) json(response, 200, { status: 'paid', total: 42 });
  else if (line === `DELETE /api/orders/${ORDER_ID}` || line === 'POST /api/test/reset') response.writeHead(204).end();
  else if (line === 'POST /api/test/sessions') json(response, 201, { session: 'session_7' });
  else json(response, 404, { error: 'no such route' });
};

type RealRun = CallRun & { readonly shop: LocalService; readonly proxy: EgressProxy; readonly consoleText: string };

type RealRunOptions = {
  readonly override?: ShopOverride;
  readonly projectFile?: JsonRecord;
  // Whether the proxy treats the shop as private; as the project file says, true unless given.
  readonly shopPrivate?: boolean;
};

// Runs `plan` with the real caller, through a proxy that allows the project's services.
async function runThroughProxy(plan: JsonRecord, options: RealRunOptions = {}): Promise<RealRun> {
  const shop = await startLocalService(shopAnswer(options.override));
  const nothingListens = await closedPort();
  const proxy = await startEgressProxy({
    policy: egressPolicy({ allowServices: [SHOP_SERVICE, STOPPED_SERVICE] }),
    services: [declaredService(SHOP_SERVICE, SHOP_ORIGIN, options.shopPrivate ?? true), declaredService(STOPPED_SERVICE, STOPPED_ORIGIN, true)],
    resolve: async (hostname) => { throw new Error(`the test looks up no name, but was asked for ${hostname}`); },
    connect: (address, port) => (port === SHOP_PORT ? shop.connect(address, port) : connect(nothingListens, '127.0.0.1')),
  });
  try {
    let ran: CallRun | undefined;
    const consoleText = await consoleWrittenDuring(async () => {
      ran = await runWithCalls(plan, { caller: realCaller(proxy), ...(options.projectFile === undefined ? {} : { projectFile: options.projectFile }) });
    });
    assert.ok(ran !== undefined);
    return { ...ran, shop, proxy, consoleText };
  } finally {
    await proxy.close();
    await shop.close();
  }
}

// The project's declaration of `name`, with `changes`.
function changedCall(name: string, changes: JsonRecord): JsonRecord {
  const declared = CALLS[name];
  assert.ok(typeof declared === 'object' && declared !== null, `no declared call ${name}`);
  return { [name]: { ...declared, ...changes } };
}

const NAVIGATE: JsonRecord = { type: 'navigate', url: '/orders' };
const ORDER_PAID = expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, 'status', { kind: 'equals', value: 'paid' });
const shortChecks = (calls: JsonRecord = {}, fields: JsonRecord = {}): JsonRecord =>
  callProjectFile(calls, { backendCheckTimeoutMilliseconds: 2000 }, fields);
const received = (shop: LocalService): string[] => shop.received.map(lineOf);
const countOf = (shop: LocalService, line: string): number => received(shop).filter((sent) => sent === line).length;
const answering = (line: string, answer: (response: Parameters<Answer>[1], earlier: readonly ReceivedRequest[]) => void): ShopOverride =>
  (request, response, earlier) => {
    if (lineOf(request) !== line) return false;
    answer(response, earlier);
    return true;
  };
const CALL_TIMEOUT = 400;

// ---- Where a call may go -------------------------------------------------------------------------------

test('through the real caller, a call to a loopback shop not declared private ends the run Errored with egress-blocked, and the shop receives nothing', { criterion: 'AC-SPEC-32-05' }, async () => {
  const projectFile = callProjectFile({}, {}, { services: [{ ...SHOP, private: false }] });
  const ran = await runThroughProxy(callPlanOf([NAVIGATE, CREATE_ORDER, NAVIGATE]), { projectFile, shopPrivate: false });
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(stepLines(ran.result), ['navigate passed', 'call failed egress-blocked', 'navigate skipped', 'expect skipped']);
  assert.deepEqual(received(ran.shop), []);
});

// Counter-example: the same plan, with the shop declared private, reaches it.
test('through the real caller, the same plan with the shop declared private passes', { criterion: 'AC-SPEC-32-05' }, async () => {
  const ran = await runThroughProxy(callPlanOf([NAVIGATE, CREATE_ORDER, NAVIGATE]));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.deepEqual(received(ran.shop), ['POST /api/orders']);
});

test('through the real caller, a redirect is judged against successStatuses and never followed', { criterion: 'AC-SPEC-32-05', timeout: 20_000 }, async () => {
  const redirecting = answering('POST /api/test/reset', (response) => response.writeHead(303, { location: `${SHOP_ORIGIN}/api/test/landing` }).end());
  const undeclared = await runThroughProxy(callPlanOf([RESET_SHOP]), { override: redirecting });
  assert.deepEqual(stepLines(undeclared.result).slice(0, 1), ['call failed unexpected-status']);
  assert.deepEqual(received(undeclared.shop), ['POST /api/test/reset'], 'the redirect was followed or the call repeated');
  const declared = await runThroughProxy(callPlanOf([RESET_SHOP]), {
    override: redirecting, projectFile: callProjectFile(changedCall('resetShop', { successStatuses: [204, 303] })),
  });
  assert.equal(declared.result.state, 'Passed', JSON.stringify(declared.result.steps));
  assert.deepEqual(received(declared.shop), ['POST /api/test/reset']);
});

// ---- A call that fails ---------------------------------------------------------------------------------

const FAILED_CALLS: readonly { readonly name: string; readonly options: RealRunOptions; readonly code: string }[] = [
  {
    name: 'a 500', code: 'unexpected-status',
    options: { override: answering('POST /api/orders', (response) => json(response, 500, { error: 'database down' })) },
  },
  {
    name: 'no answer before its timeout', code: 'call-timeout',
    options: { override: answering('POST /api/orders', () => undefined), projectFile: callProjectFile(changedCall('createOrder', { timeoutMilliseconds: CALL_TIMEOUT })) },
  },
  {
    name: 'no connection, as nothing listens on its service', code: 'service-unreachable',
    options: { projectFile: callProjectFile(changedCall('createOrder', { service: STOPPED_SERVICE }), {}, { services: [SHOP, STOPPED] }) },
  },
];

for (const failed of FAILED_CALLS) {
  test(`through the real caller, a call that gets ${failed.name} ends the run Errored with ${failed.code}, skips later steps, and cleanup still runs`, { criterion: 'AC-SPEC-32-07' }, async () => {
    const ran = await runThroughProxy(withCleanup(callPlanOf([NAVIGATE, CREATE_ORDER, NAVIGATE]), [RESET_SHOP]), failed.options);
    assert.equal(ran.result.state, 'Errored');
    assert.deepEqual(stepLines(ran.result), ['navigate passed', `call failed ${failed.code}`, 'navigate skipped', 'expect skipped']);
    assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['passed']);
    assert.equal(received(ran.shop).at(-1), 'POST /api/test/reset', 'the cleanup call reached the shop');
  });
}

// ---- Backend checks poll; a write is sent once -------------------------------------------------------------

test('through the real caller, a backend check whose field matches only on the third read passes after three reads', { criterion: 'AC-SPEC-32-09' }, async () => {
  const paidOnThirdRead = answering(`GET /api/orders/${ORDER_ID}`, (response, earlier) => {
    const readsBefore = earlier.filter((request) => request.method === 'GET').length;
    json(response, 200, { status: readsBefore >= 2 ? 'paid' : 'pending', total: 42 });
  });
  const ran = await runThroughProxy(callPlanOf([CREATE_ORDER, ORDER_PAID]), { override: paidOnThirdRead, projectFile: shortChecks() });
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['call passed', 'expectBackend passed']);
  assert.equal(ran.result.state, 'Passed');
  assert.equal(countOf(ran.shop, `GET /api/orders/${ORDER_ID}`), 3);
});

test('through the real caller, a backend check whose field never matches fails with assertion-failed after polling', { criterion: 'AC-SPEC-32-09' }, async () => {
  const neverPaid = answering(`GET /api/orders/${ORDER_ID}`, (response) => json(response, 200, { status: 'pending', total: 42 }));
  const ran = await runThroughProxy(callPlanOf([CREATE_ORDER, ORDER_PAID]), { override: neverPaid, projectFile: shortChecks() });
  assert.deepEqual(stepLines(ran.result).slice(0, 3), ['call passed', 'expectBackend failed assertion-failed', 'expect skipped']);
  assert.equal(ran.result.state, 'Failed');
  assert.ok(ran.clock.elapsed() >= 2000, `the check gave up after ${ran.clock.elapsed()} ms`);
  assert.ok(countOf(ran.shop, `GET /api/orders/${ORDER_ID}`) > 1, 'the read was polled');
});

test('through the real caller, a write that times out reached the shop exactly once', { criterion: 'AC-SPEC-32-09' }, async () => {
  const ran = await runThroughProxy(callPlanOf([CREATE_ORDER]), {
    override: answering('POST /api/orders', () => undefined),
    projectFile: shortChecks(changedCall('createOrder', { timeoutMilliseconds: CALL_TIMEOUT })),
  });
  await settle(CALL_TIMEOUT * 3);
  assert.deepEqual(stepLines(ran.result).slice(0, 1), ['call failed call-timeout']);
  assert.equal(ran.result.state, 'Errored');
  assert.equal(countOf(ran.shop, 'POST /api/orders'), 1);
});

// ---- Reading the response -----------------------------------------------------------------------------------

const RESPONSE_CASES: readonly { readonly name: string; readonly answer: (response: Parameters<Answer>[1]) => void; readonly code: string; readonly calls?: JsonRecord }[] = [
  {
    name: 'larger than its cap', code: 'response-too-large', calls: changedCall('createOrder', { maximumResponseBytes: 256 }),
    answer: (response) => json(response, 201, { id: ORDER_ID, status: 'pending', padding: 'x'.repeat(10_000) }),
  },
  { name: 'an HTML page', code: 'response-not-json', answer: (response) => response.writeHead(201, { 'content-type': 'text/html' }).end('<html><body>Created</body></html>') },
  { name: 'labelled JSON but not JSON', code: 'response-not-json', answer: (response) => response.writeHead(201, { 'content-type': 'application/json' }).end('{"id": "ord_1042",') },
  { name: 'JSON without the remembered field', code: 'field-missing', answer: (response) => json(response, 201, { status: 'pending' }) },
];

for (const responseCase of RESPONSE_CASES) {
  test(`through the real caller, a call whose response is ${responseCase.name} fails with ${responseCase.code}`, { criterion: 'AC-SPEC-32-10' }, async () => {
    const ran = await runThroughProxy(callPlanOf([CREATE_ORDER]), {
      override: answering('POST /api/orders', responseCase.answer), projectFile: callProjectFile(responseCase.calls ?? {}),
    });
    assert.deepEqual(stepLines(ran.result).slice(0, 1), [`call failed ${responseCase.code}`]);
    assert.equal(ran.result.state, 'Errored');
  });
}

// Counter-example: a response just within its cap is read.
test('through the real caller, a response within its cap is read and its field remembered', { criterion: 'AC-SPEC-32-10' }, async () => {
  const ran = await runThroughProxy(callPlanOf([CREATE_ORDER, call('getOrder', { orderId: { valueName: 'orderId' } })]), {
    projectFile: callProjectFile(changedCall('createOrder', { maximumResponseBytes: 256 })),
  });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.deepEqual(received(ran.shop), ['POST /api/orders', `GET /api/orders/${ORDER_ID}`]);
});

// ---- No echo of a secret or a header value --------------------------------------------------------------------

const basicForm = (value: string): string => Buffer.from(value).toString('base64');

// A careless shop: every answer echoes the headers and body it received, the bearer token alone
// under /echo/token, and each secret's raw, base64 and URI forms.
const echoingShop: ShopOverride = (request, response) => {
  const authorization = request.headers.authorization ?? '';
  const echoes = Object.values(SECRET_VALUES).flatMap((value) => [value, basicForm(value), encodeURIComponent(value)]);
  const echo = { token: authorization.replace(/^Bearer /, ''), headers: request.headers, body: request.body, all: echoes };
  const line = lineOf(request);
  if (line === 'POST /api/orders') json(response, 201, { id: ORDER_ID, status: 'pending', echo });
  else if (line === `GET /api/orders/${ORDER_ID}`) json(response, 200, { status: 'paid', total: 42, echo });
  else if (line === 'POST /api/test/sessions') json(response, 201, { session: 'session_7', echo });
  else return false;
  return true;
};

// Creates an order, signs in with a password secret in the body, then checks a field that echoes
// the token against a text it can never equal, so the failed check keeps what it observed; cleanup
// resets the shop with the basic scheme.
const echoPlan = withCleanup(callPlanOf([
  CREATE_ORDER,
  call('signInAsAdmin', { adminPassword: { secretName: ADMIN_PASSWORD_SECRET } }),
  expectBackend('getOrder', { orderId: { valueName: 'orderId' } }, 'echoedToken', { kind: 'equals', value: 'deliberately wrong' }),
]), [RESET_SHOP]);

const everythingKept = (ran: RealRun): string => `${ran.everything}\n${JSON.stringify(ran.proxy.decisions())}\n${ran.consoleText}`;

test('through the real caller, the secrets reach the shop, yet no form of any secret reaches the result, the log, the proxy or the console', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runThroughProxy(echoPlan, { override: echoingShop, projectFile: shortChecks() });
  assert.equal(ran.result.state, 'Failed', 'the echo check failed, so the run kept what it observed');

  // The probe is live: each secret went out on the wire, in the form the declaration asks for.
  const sent = (line: string): ReceivedRequest | undefined => ran.shop.received.find((request) => lineOf(request) === line);
  assert.equal(sent('POST /api/orders')?.headers.authorization, `Bearer ${SECRET_VALUES[TOKEN_SECRET] ?? ''}`);
  assert.equal(sent('POST /api/orders')?.headers['x-test-suite'], HEADER_MARKER);
  assert.equal(sent('POST /api/test/reset')?.headers.authorization, `Basic ${basicForm(SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '')}`);
  assert.deepEqual(JSON.parse(sent('POST /api/test/sessions')?.body ?? 'null'), { password: SECRET_VALUES[ADMIN_PASSWORD_SECRET] });

  const kept = everythingKept(ran);
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    assert.deepEqual(echoesIn(kept, value), [], `${name} was echoed`);
    assert.ok(!kept.includes(basicForm(value)), `${name} was echoed in its basic form`);
  }
});

test('through the real caller, no header value is recorded in the result, the log, the proxy\'s decisions or the console', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runThroughProxy(echoPlan, { override: echoingShop, projectFile: shortChecks() });
  const kept = everythingKept(ran);
  assert.ok(!kept.includes(HEADER_MARKER), 'a literal header value was recorded');
  assert.ok(!kept.toLowerCase().includes('bearer '), 'an authorization header was recorded');
});

test('through the real caller, the leak scan finds no secret in what the run kept, and does find a planted canary', { criterion: 'AC-SPEC-32-11' }, async () => {
  const ran = await runThroughProxy(echoPlan, { override: echoingShop, projectFile: shortChecks() });
  const folder = mkdtempSync(join(tmpdir(), 'real-caller-leaks-'));
  try {
    const canaryValue = fakeSecretValue();
    const files = [
      ['result.json', JSON.stringify(ran.result)],
      ['events.json', JSON.stringify(ran.events)],
      ['proxy-decisions.json', JSON.stringify(ran.proxy.decisions())],
      ['console.txt', ran.consoleText],
      ['canary.txt', canaryValue],
    ].map(([name, text]) => {
      const path = join(folder, name ?? '');
      writeFileSync(path, text ?? '');
      return path;
    });
    const secrets = [
      ...Object.entries(SECRET_VALUES).map(([name, value]) => resolvedSecret(name, value)),
      resolvedSecret('LEAK_SCAN_CANARY', canaryValue),
    ];
    const leaks = leakScanner().scan(files, secrets);
    assert.deepEqual(leaks.filter((leak) => leak.secret !== 'LEAK_SCAN_CANARY'), [], 'a secret leaked into what the run kept');
    assert.ok(leaks.some((leak) => leak.secret === 'LEAK_SCAN_CANARY' && leak.file.endsWith('canary.txt')), 'the scan did not see the canary');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
