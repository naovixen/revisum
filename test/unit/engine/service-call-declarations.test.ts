// Call declarations in the trusted project file. A person declares each call: its service, method,
// path, query, headers and JSON body as templates, its typed parameters, its effect, the statuses
// that count as success and the response fields a plan may read. The project parser refuses a
// declaration that could reach an undeclared service, splice text into a string, set a header
// that changes where or how a request travels, or read a field by a broken pointer. Each case
// below changes one thing in a declaration the parser accepts, so the refusal comes from that
// change. The project's new limits, maximumCalls and backendCheckTimeoutMilliseconds, are read
// here too. And a declaration added or changed by the change under test is never trusted: the
// protected branch's project.json is used, and the edit raises a changed-with-code review item.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject, type TrustedProject } from '@revisum/engine';
import { PROJECT_PATH, loadForChange, memoryEventSink, withRepository, type FixtureRepository } from './approval-repositories.ts';
import {
  CALLS, SHOP, SHOP_ORIGIN, callProject, callProjectFile, declarationOf, projectRefusal, type JsonRecord,
} from './service-call-examples.ts';

// The shared project with one declaration replaced by `declaration`.
const withCall = (name: string, declaration: JsonRecord): JsonRecord => callProjectFile({ [name]: declaration });
const createOrder = (): JsonRecord => structuredClone(CALLS['createOrder']) as JsonRecord;
const getOrder = (): JsonRecord => structuredClone(CALLS['getOrder']) as JsonRecord;
const accepts = (projectFile: JsonRecord): void => {
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, JSON.stringify(parsed));
};

// One error, with this code, at this path or inside it (such as the parameter list of an
// $interpolate template).
function assertRefusedAt(errors: readonly string[], code: string, path: string): void {
  assert.equal(errors.length, 1, JSON.stringify(errors));
  const [foundCode, foundPath = ''] = (errors[0] ?? '').split(' ');
  assert.equal(foundCode, code, JSON.stringify(errors));
  assert.ok(foundPath === path || foundPath.startsWith(`${path}.`) || foundPath.startsWith(`${path}[`), `${foundPath} is not at ${path}`);
}

// ---- The declarations the parser accepts ----------------------------------------------------------

test('the shared call declarations parse, and the project keeps each by name', { criterion: 'AC-SPEC-32-01' }, () => {
  const project = callProject();
  assert.deepEqual(Object.keys(project.calls).sort(), Object.keys(CALLS).sort());
  const declaration = declarationOf(project, 'getOrder');
  assert.equal(declaration.service, 'shop');
  assert.equal(declaration.method, 'GET');
  assert.equal(declaration.path, '/api/orders/{orderId}');
  assert.equal(declaration.effect, 'read');
  assert.deepEqual(declaration.successStatuses, [200]);
});

test('a project with no calls section declares no calls', { criterion: 'AC-SPEC-32-01' }, () => {
  const parsed = parseProject(callProjectFile({}, {}, { calls: undefined }));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(Object.keys(parsed.value.calls), []);
});

test('a declaration that does not set allowInProposals does not allow itself in proposals', { criterion: 'AC-SPEC-32-06' }, () => {
  assert.equal(declarationOf(callProject(), 'getOrder').allowInProposals, false);
  assert.equal(declarationOf(callProject(), 'createOrder').allowInProposals, true);
});

test('the project keeps its declared services by name, origin and whether they are private', { criterion: 'AC-SPEC-32-01' }, () => {
  assert.deepEqual(JSON.parse(JSON.stringify(callProject().services)), [SHOP]);
});

// ---- An undeclared service --------------------------------------------------------------------------

test('a call to a service the project does not declare is refused with unknown_value at its service', { criterion: 'AC-SPEC-32-01' }, () => {
  const errors = projectRefusal(withCall('getOrder', { ...getOrder(), service: 'payments' }));
  assert.deepEqual(errors, ['unknown_value $.calls.getOrder.service']);
});

test('a call naming a service is refused when the project declares no services at all', { criterion: 'AC-SPEC-32-01' }, () => {
  const errors = projectRefusal(callProjectFile({}, {}, { services: undefined, calls: { getOrder: getOrder() } }));
  assert.deepEqual(errors, ['unknown_value $.calls.getOrder.service']);
});

// ---- Path placeholders ------------------------------------------------------------------------------

test('a path placeholder that names no parameter is refused with unknown_value at the path', { criterion: 'AC-SPEC-32-01' }, () => {
  assert.deepEqual(projectRefusal(withCall('getOrder', { ...getOrder(), path: '/api/orders/{orderNumber}' })), ['unknown_value $.calls.getOrder.path']);
});

for (const path of ['/api/orders/order-{orderId}', '/api/orders/{orderId}.json', '/api/orders/{orderId}{orderId}', '/api/orders?id={orderId}']) {
  test(`a placeholder that fills part of a segment, ${JSON.stringify(path)}, is refused with unknown_value at the path`, { criterion: 'AC-SPEC-32-01' }, () => {
    assert.deepEqual(projectRefusal(withCall('getOrder', { ...getOrder(), path })), ['unknown_value $.calls.getOrder.path']);
  });
}

// Counter-example: whole-segment placeholders, in any position, are accepted.
test('placeholders that each fill a whole segment are accepted', { criterion: 'AC-SPEC-32-01' }, () => {
  for (const path of ['/{orderId}', '/api/orders/{orderId}', '/api/{orderId}/lines']) accepts(withCall('getOrder', { ...getOrder(), path }));
});

// ---- Interpolation inside a string ------------------------------------------------------------------

// A declaration with one parameter of `type`, interpolated inside a body string and a query value.
const interpolating = (type: JsonRecord, where: 'body' | 'query'): JsonRecord => {
  const template = { $interpolate: 'select * from orders where code = {code}', parameters: ['code'] };
  return {
    ...getOrder(), method: 'POST', path: '/api/sql', effect: 'write', allowInProposals: false,
    parameters: { code: type },
    ...(where === 'body' ? { body: { statement: template } } : { query: { filter: template } }),
  };
};

const UNSAFE_TYPES: readonly JsonRecord[] = [
  { kind: 'text', maximumLength: 20 }, { kind: 'email' }, { kind: 'boolean' }, { kind: 'secret' },
  // oneOf is safe only when every value is: a space, a quote or a separator makes it unsafe.
  { kind: 'oneOf', values: ['eu', 'us west'] }, { kind: 'oneOf', values: ["o'brien"] }, { kind: 'oneOf', values: ['a/b'] },
];

for (const type of UNSAFE_TYPES) {
  for (const where of ['body', 'query'] as const) {
    test(`a ${JSON.stringify(type)} parameter interpolated inside a ${where} string is refused with unsafe_interpolation`, { criterion: 'AC-SPEC-32-01' }, () => {
      const path = where === 'body' ? '$.calls.runSql.body.statement' : '$.calls.runSql.query.filter';
      assertRefusedAt(projectRefusal(withCall('runSql', interpolating(type, where))), 'unsafe_interpolation', path);
    });
  }
}

const SAFE_TYPES: readonly JsonRecord[] = [
  { kind: 'identifier' }, { kind: 'integer', minimum: 0, maximum: 1000 }, { kind: 'yearMonthDay' }, { kind: 'oneOf', values: ['eu', 'us', 'apac_2'] },
];

// Counter-example: the same template with a type that cannot hold a quote, space or separator.
for (const type of SAFE_TYPES) {
  test(`a ${JSON.stringify(type)} parameter may be interpolated inside a string`, { criterion: 'AC-SPEC-32-01' }, () => {
    accepts(withCall('runSql', interpolating(type, 'body')));
    accepts(withCall('runSql', interpolating(type, 'query')));
  });
}

test('a text parameter may still fill a whole JSON value, where it is one string', { criterion: 'AC-SPEC-32-01' }, () => {
  accepts(withCall('runSql', { ...interpolating({ kind: 'text', maximumLength: 20 }, 'body'), body: { code: { $parameter: 'code' } } }));
});

test('an $interpolate naming a parameter its declaration lacks is refused with unknown_value', { criterion: 'AC-SPEC-32-01' }, () => {
  const declaration = { ...interpolating({ kind: 'identifier' }, 'body'), body: { statement: { $interpolate: 'x = {other}', parameters: ['other'] } } };
  assertRefusedAt(projectRefusal(withCall('runSql', declaration)), 'unknown_value', '$.calls.runSql.body.statement');
});

// ---- Headers ----------------------------------------------------------------------------------------

const FORBIDDEN_HEADERS = [
  'host', 'cookie', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'Host', 'COOKIE', 'Content-Length',
];

for (const header of FORBIDDEN_HEADERS) {
  test(`a declaration setting the header "${header}" is refused with header_not_allowed at that header`, { criterion: 'AC-SPEC-32-01' }, () => {
    const declaration = { ...getOrder(), headers: { ...(getOrder()['headers'] as JsonRecord), [header]: { literal: 'shop.example.com' } } };
    assert.deepEqual(projectRefusal(withCall('getOrder', declaration)), [`header_not_allowed $.calls.getOrder.headers.${header}`]);
  });
}

// Counter-example: ordinary request headers, literal or from a secret, are accepted.
test('authorization, accept and x- headers are accepted, literal or from a declared secret', { criterion: 'AC-SPEC-32-01' }, () => {
  accepts(withCall('getOrder', {
    ...getOrder(),
    headers: {
      authorization: { secretName: 'SHOP_API_TOKEN', scheme: 'token' }, accept: { literal: 'application/json' },
      'x-api-key': { secretName: 'SHOP_API_TOKEN', scheme: 'raw' }, 'x-test-suite': { literal: 'orders' },
    },
  }));
});

// ---- Literal keys that look like placeholders --------------------------------------------------------

for (const [body, path] of [
  [{ $where: 'this.admin == true' }, '$.calls.runQuery.body.$where'],
  [{ filter: { $ne: null } }, '$.calls.runQuery.body.filter.$ne'],
  [{ lines: [{ $set: { price: 0 } }] }, '$.calls.runQuery.body.lines[0].$set'],
] as const) {
  test(`a literal object key starting with "$" (${path.split('.').at(-1)}) is refused with unknown_value`, { criterion: 'AC-SPEC-32-01' }, () => {
    const declaration = { ...getOrder(), method: 'POST', path: '/api/query', effect: 'write', parameters: {}, body };
    assertRefusedAt(projectRefusal(withCall('runQuery', declaration)), 'unknown_value', path);
  });
}

test('a $parameter that names no declared parameter is refused with unknown_value', { criterion: 'AC-SPEC-32-01' }, () => {
  const declaration = { ...createOrder(), body: { customer: { $parameter: 'customerRole' } } };
  assertRefusedAt(projectRefusal(withCall('createOrder', declaration)), 'unknown_value', '$.calls.createOrder.body.customer');
});

// Counter-example: a key with a "$" inside it, not at the start, is an ordinary key.
test('a literal key with a "$" after its first character is kept as an ordinary key', { criterion: 'AC-SPEC-32-01' }, () => {
  accepts(withCall('runQuery', { ...getOrder(), method: 'POST', path: '/api/query', effect: 'write', parameters: {}, body: { price$: 3, 'total$amount': 4 } }));
});

// ---- Field pointers ---------------------------------------------------------------------------------

for (const pointer of ['id', '#/id', 'status/', '/a~2b', '/a~', ' /id']) {
  test(`a field pointer that is not a JSON pointer, ${JSON.stringify(pointer)}, is refused with unknown_value at the field`, { criterion: 'AC-SPEC-32-01' }, () => {
    const declaration = { ...getOrder(), fields: { status: pointer } };
    assert.deepEqual(projectRefusal(withCall('getOrder', declaration)), ['unknown_value $.calls.getOrder.fields.status']);
  });
}

// Counter-example: valid pointers, with escapes and array indexes, are accepted.
test('valid JSON pointers, including "", array indexes and ~0 and ~1 escapes, are accepted', { criterion: 'AC-SPEC-32-01' }, () => {
  accepts(withCall('getOrder', { ...getOrder(), fields: { whole: '', status: '/status', firstLine: '/lines/0/id', slashed: '/a~1b', tilde: '/a~0b' } }));
});

// ---- Names, methods and the rest of a declaration -------------------------------------------------

test('a call, parameter or field name outside the pattern is refused with unknown_value at the name', { criterion: 'AC-SPEC-32-01' }, () => {
  assert.deepEqual(projectRefusal(withCall('Get-Order', getOrder())), ['unknown_value $.calls.Get-Order']);
  assertRefusedAt(projectRefusal(withCall('getOrder', { ...getOrder(), fields: { 'order-status': '/status' } })), 'unknown_value', '$.calls.getOrder.fields.order-status');
});

test('a method outside GET, HEAD, POST, PUT, PATCH and DELETE is refused with unknown_value', { criterion: 'AC-SPEC-32-01' }, () => {
  for (const method of ['CONNECT', 'TRACE', 'OPTIONS', 'get', 'PROPFIND']) {
    assert.deepEqual(projectRefusal(withCall('getOrder', { ...getOrder(), method })), ['unknown_value $.calls.getOrder.method'], method);
  }
});

test('an effect other than read or write is refused with unknown_value', { criterion: 'AC-SPEC-32-01' }, () => {
  assert.deepEqual(projectRefusal(withCall('getOrder', { ...getOrder(), effect: 'none' })), ['unknown_value $.calls.getOrder.effect']);
});

test('a declaration field the format does not have, such as a full URL, is refused with unknown_field', { criterion: 'AC-SPEC-32-01' }, () => {
  assert.deepEqual(projectRefusal(withCall('getOrder', { ...getOrder(), url: `${SHOP_ORIGIN}/api/orders` })), ['unknown_field $.calls.getOrder.url']);
});

test('a header literal holding a line break is refused, so no header can be smuggled in', { criterion: 'AC-SPEC-32-03' }, () => {
  for (const literal of ['orders\r\nHost: evil.example', 'orders\nX-Admin: true', 'orders\r']) {
    const declaration = { ...getOrder(), headers: { 'x-test-suite': { literal } } };
    assertRefusedAt(projectRefusal(withCall('getOrder', declaration)), 'unsafe_text', '$.calls.getOrder.headers.x-test-suite');
  }
});

test('a header naming a secret the project does not declare is refused at its secret name', { criterion: 'AC-SPEC-32-12' }, () => {
  const declaration = { ...getOrder(), headers: { authorization: { secretName: 'PRODUCTION_DATABASE_URL', scheme: 'bearer' } } };
  assertRefusedAt(projectRefusal(withCall('getOrder', declaration)), 'unknown_value', '$.calls.getOrder.headers.authorization');
});

// ---- The project's limits for calls -------------------------------------------------------------------

const limitsOf = (limits: Readonly<Record<string, number>> = {}): Readonly<Record<string, unknown>> => callProject({}, limits).limits;

test('a project that sets no call limits allows 20 calls and backend checks of 10 s', { criterion: 'AC-SPEC-32-06' }, () => {
  assert.equal(limitsOf()['maximumCalls'], 20);
  assert.equal(limitsOf()['backendCheckTimeoutMilliseconds'], 10_000);
});

test('maximumCalls may be 1 to 200 and backendCheckTimeoutMilliseconds 1 to 120000', { criterion: 'AC-SPEC-32-06' }, () => {
  for (const maximumCalls of [1, 200]) assert.equal(limitsOf({ maximumCalls })['maximumCalls'], maximumCalls);
  for (const timeout of [1, 120_000]) assert.equal(limitsOf({ backendCheckTimeoutMilliseconds: timeout })['backendCheckTimeoutMilliseconds'], timeout);
});

test('a call limit over its ceiling, of 0, or not a whole number is refused at the limit', { criterion: 'AC-SPEC-32-06' }, () => {
  for (const [key, value] of [['maximumCalls', 201], ['maximumCalls', 0], ['maximumCalls', 2.5], ['backendCheckTimeoutMilliseconds', 120_001], ['backendCheckTimeoutMilliseconds', 0]] as const) {
    const errors = projectRefusal(callProjectFile({}, { [key]: value }));
    assert.deepEqual(errors.map((error) => error.split(' ')[1]), [`$.limits.${key}`], `${key} ${value}`);
    assert.notEqual(errors[0]?.split(' ')[0], 'unknown_field', `${key} is a known limit`);
  }
});

// ---- A declaration edited by the change under test -----------------------------------------------------

const APPLICATION_CODE = 'src/orders.ts';
const APPLICATION_SOURCE = 'export const order = () => fetch("/api/orders");\n';

// The protected branch's project.json declares the shared calls, getOrder among them as a read
// not allowed in proposals. The change under test's own project.json, in its working copy, turns
// getOrder into a write allowed in proposals and adds a dropTables call; the change also edits
// application code.
const editsCallsWithCode = (fixture: FixtureRepository): void => {
  fixture.protectedFiles[PROJECT_PATH] = callProjectFile();
  fixture.workingCopy[PROJECT_PATH] = callProjectFile({
    getOrder: { ...getOrder(), effect: 'write', allowInProposals: true },
    dropTables: { ...getOrder(), method: 'POST', path: '/api/sql', effect: 'write', allowInProposals: true, parameters: {}, body: { statement: 'drop table orders' } },
  });
  fixture.workingCopy[APPLICATION_CODE] = APPLICATION_SOURCE;
};

async function withEditingChange(body: (loaded: { project: TrustedProject; reviewItems: readonly unknown[] }) => void): Promise<void> {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    body(loaded.value);
  }, editsCallsWithCode);
}

test('when the change edits a call declaration, the run uses the protected-branch declaration', { criterion: 'AC-SPEC-32-14' }, async () => {
  await withEditingChange(({ project }) => {
    assert.deepEqual(Object.keys(project.calls).sort(), Object.keys(CALLS).sort(), 'a call only the change declares was trusted');
    const declaration = declarationOf(project, 'getOrder');
    assert.equal(declaration.effect, 'read');
    assert.equal(declaration.allowInProposals, false);
    assert.equal(project.provenance.kind, 'protected-branch');
  });
});

test('a call declaration edited with application code raises changed-with-code naming project.json', { criterion: 'AC-SPEC-32-14' }, async () => {
  await withEditingChange(({ reviewItems }) => {
    assert.deepEqual(reviewItems, [{ code: 'changed-with-code', path: PROJECT_PATH }]);
  });
});

// Counter-example: the same protected project, with a change that leaves project.json alone,
// raises no review item and still declares getOrder as a read.
test('a change that does not touch project.json raises no review item for it', { criterion: 'AC-SPEC-32-14' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [APPLICATION_CODE], memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.deepEqual(loaded.value.reviewItems, []);
    assert.equal(declarationOf(loaded.value.project, 'getOrder').effect, 'read');
  }, (fixture) => {
    fixture.protectedFiles[PROJECT_PATH] = callProjectFile();
    fixture.workingCopy[APPLICATION_CODE] = APPLICATION_SOURCE;
  });
});
