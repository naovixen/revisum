// buildServiceRequest turns a declaration, a plan's arguments, the run's values and its secrets
// into the one request the declaration allows. It is pure: no I/O. Whatever the arguments hold,
// the request keeps the declaration's origin, method, header names and number of path segments.
// Text fills a whole JSON value, a whole path segment or a whole query value, so quotes, "{other}",
// "../", "%2F", JSON fragments and SQL can never change the request's shape. Values that reach
// a call by name are checked against the parameter's type when the request is built, and a value
// that fails is refused before anything is sent.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildServiceRequest, environmentSecretStore, reveal,
  type CallArguments, type Plan, type RunValues, type SafeText, type ServiceRequest, type ValueName,
} from '@revisum/engine';
import { accepted, rejection } from './run-value-examples.ts';
import {
  ADMIN_LOGIN_SECRET, ADMIN_PASSWORD_SECRET, CALLS, HEADER_MARKER, SECRET_VALUES, SHOP_ORIGIN, TOKEN_SECRET,
  call, callParser, callPlanOf, callProject, declarationOf, orderArguments, serviceOf, type JsonRecord,
} from './service-call-examples.ts';

const project = callProject();
const parsePlan = callParser();
const secrets = environmentSecretStore(SECRET_VALUES);
const NO_VALUES: RunValues = new Map();

// Run values as the engine holds them. In a run they come from the plan's generated values and
// from remembered response fields; here a test sets them directly.
const valuesOf = (entries: Readonly<Record<string, string>>): RunValues =>
  new Map(Object.entries(entries).map(([name, text]) => [name as ValueName, text as SafeText]));

// The arguments of the first step of a plan the parser accepted: SafeText, typed by the parser.
function parsedArguments(plan: Plan): CallArguments {
  const step = plan.steps[0];
  assert.ok(step !== undefined && step.type === 'call', 'the first step is a call');
  return step.arguments;
}

// A run value the plan defines, so a reference to it parses; its text is set per test.
const KEPT_VALUE = { kind: 'uniqueText', prefix: 'kept' };
const argumentsFor = (name: string, callArguments: JsonRecord, definedValues: readonly string[] = []): CallArguments =>
  parsedArguments(accepted(parsePlan, callPlanOf([call(name, callArguments)],
    definedValues.length === 0 ? {} : { values: Object.fromEntries(definedValues.map((valueName) => [valueName, KEPT_VALUE])) })));

function built(name: string, callArguments: CallArguments, values: RunValues = NO_VALUES): ServiceRequest {
  const declaration = declarationOf(project, name);
  const outcome = buildServiceRequest(declaration, serviceOf(project, declaration.service), callArguments, values, secrets);
  assert.ok(outcome.ok, `the request was not built: ${JSON.stringify(outcome)}`);
  return outcome.value;
}

function refusedBuild(name: string, callArguments: CallArguments, values: RunValues = NO_VALUES, store = secrets): string {
  const declaration = declarationOf(project, name);
  const outcome = buildServiceRequest(declaration, serviceOf(project, declaration.service), callArguments, values, store);
  assert.equal(outcome.ok, false, 'the request was built');
  return outcome.ok ? '' : outcome.error;
}

// A request body is JSON text in parts, where a part may be a hidden secret. These tests read
// bodies that hold no secret, so every part is text; a secret part fails the test.
const bodyJson = (request: ServiceRequest): unknown => {
  if (request.body === null) return null;
  const parts = request.body.jsonParts.map((part) => {
    assert.equal(typeof part, 'string', 'the body holds a secret part');
    return String(part);
  });
  return JSON.parse(parts.join(''));
};
const pathOf = (request: ServiceRequest): string => request.pathAndQuery.split('?')[0] ?? '';
const queryOf = (request: ServiceRequest): URLSearchParams => new URLSearchParams(request.pathAndQuery.split('?')[1] ?? '');
const headerNames = (request: ServiceRequest): string[] => request.headers.map((header) => header.name.toLowerCase()).sort();
const headerNamed = (request: ServiceRequest, name: string) => request.headers.find((header) => header.name.toLowerCase() === name);

// Every string in a JSON value, depth first.
const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
};

// ---- Generated arguments ------------------------------------------------------------------------------

// Pieces of hostile text, every one of them safe text: quotes, SQL, placeholders, path escapes,
// encoded separators, JSON fragments and non-Latin script.
const FRAGMENTS = [
  "'", '"', "'; DROP TABLE orders; --", '{other}', '{customerId}', '{page}', '../', '..%2F', '%2F', '%2e%2e', '/', '?', '#', '&',
  '+', ' ', '\\', '{"admin":true}', '"},{"role":"admin', '[1,2]', 'null', '%00', '%0d%0a', 'x=1&y=2', 'Zoë', '注文番号',
  'Ελληνικά', 'مرحبا', 'Привет', '🚀', 'Ada', '$parameter', '${injected}',
];
const REGIONS = ['eu', 'us', 'apac'];

// A small seeded generator (mulberry32), so every run of the test sees the same 1,000 sets.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type NoteArguments = {
  readonly customerId: string; readonly note: string; readonly author: string; readonly tag: string;
  readonly page: number; readonly region: string; readonly vip: boolean;
};

function generatedSets(count: number): NoteArguments[] {
  const random = seededRandom(32);
  const pick = <Item>(items: readonly Item[]): Item => items[Math.floor(random() * items.length)] ?? assert.fail('empty list');
  const text = (): string => Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(FRAGMENTS)).join('');
  return Array.from({ length: count }, () => ({
    customerId: text(), note: text(), author: text(), tag: text(),
    page: 1 + Math.floor(random() * 1000), region: pick(REGIONS), vip: random() < 0.5,
  }));
}

const GENERATED = generatedSets(1000);
const NOTE_DECLARATION = CALLS['addCustomerNote'] as JsonRecord;
const DECLARED_HEADERS = Object.keys(NOTE_DECLARATION['headers'] as JsonRecord).sort();

// ---- The request keeps the declaration's shape --------------------------------------------------------

test('over 1,000 generated argument sets, the origin, method, header names and path segment count never change', { criterion: 'AC-SPEC-32-03' }, () => {
  const shapes = new Set<string>();
  for (const generated of GENERATED) {
    const request = built('addCustomerNote', argumentsFor('addCustomerNote', generated));
    assert.equal(request.origin, SHOP_ORIGIN, JSON.stringify(generated));
    assert.equal(request.method, 'POST');
    // The body is JSON, so the request may carry a content type; every other header is declared.
    assert.deepEqual(headerNames(request).filter((name) => name !== 'content-type'), DECLARED_HEADERS, JSON.stringify(generated));
    const segments = pathOf(request).split('/');
    assert.equal(segments.length, '/api/customers/{customerId}/notes'.split('/').length, `${pathOf(request)} from ${JSON.stringify(generated.customerId)}`);
    assert.deepEqual([segments[1], segments[2], segments[4]], ['api', 'customers', 'notes']);
    shapes.add(JSON.stringify([request.origin, request.method, headerNames(request), segments.length]));
  }
  assert.equal(shapes.size, 1, 'every generated set gives a request of one shape');
});

test('a text argument fills exactly its path segment and its query value, percent-encoded', { criterion: 'AC-SPEC-32-03' }, () => {
  for (const generated of GENERATED) {
    const request = built('addCustomerNote', argumentsFor('addCustomerNote', generated));
    assert.equal(decodeURIComponent(pathOf(request).split('/')[3] ?? ''), generated.customerId, JSON.stringify(generated));
    const query = queryOf(request);
    assert.deepEqual([...query.keys()].sort(), ['page', 'tag'], request.pathAndQuery);
    assert.equal(query.get('tag'), generated.tag, request.pathAndQuery);
    assert.equal(query.get('page'), String(generated.page));
    assert.ok(!request.pathAndQuery.includes('#'), `a fragment marker reached the request: ${request.pathAndQuery}`);
  }
});

test('the body is valid JSON in which each text argument is exactly one string value', { criterion: 'AC-SPEC-32-03' }, () => {
  for (const generated of GENERATED) {
    const request = built('addCustomerNote', argumentsFor('addCustomerNote', generated));
    assert.ok(request.body !== null, 'the declaration has a body');
    const body: unknown = bodyJson(request);
    const statement = `select * from notes where page = ${generated.page} and region = '${generated.region}'`;
    assert.deepEqual(body, {
      note: generated.note, author: { name: generated.author }, tags: [generated.tag, 'fixed'], vip: generated.vip, statement,
    }, JSON.stringify(generated));
    // No text was split, joined or spliced: the strings are exactly the arguments and the literals.
    assert.deepEqual(stringsIn(body).sort(), [generated.note, generated.author, generated.tag, 'fixed', statement].sort());
  }
});

test('no argument text reaches a header', { criterion: 'AC-SPEC-32-03' }, () => {
  for (const generated of GENERATED.slice(0, 100)) {
    const request = built('addCustomerNote', argumentsFor('addCustomerNote', generated));
    const literal = headerNamed(request, 'x-test-suite');
    assert.equal(literal?.value, HEADER_MARKER);
  }
});

// The generator must stay inside safe text, or the sets above would not reach the builder at all.
test('control: every generated argument set is one the plan parser accepts', { criterion: 'AC-SPEC-32-03' }, () => {
  const refused = GENERATED.filter((generated) => !parsePlan(callPlanOf([call('addCustomerNote', generated)])).ok);
  assert.deepEqual(refused, []);
});

// Mutant: splicing the same text into the path, as string templating would, changes the shape;
// so the segment-count oracle above can fail.
test('mutant: a request whose path is built by splicing text changes the segment count', { criterion: 'AC-SPEC-32-03' }, () => {
  const spliced = GENERATED.filter((generated) => `/api/customers/${generated.customerId}/notes`.split('?')[0]?.split('/').length !== 5);
  assert.ok(spliced.length > 100, `only ${spliced.length} generated sets would break a spliced path`);
});

// ---- Line breaks never reach a request -----------------------------------------------------------------

for (const lineBreak of ['\r', '\n', '\r\n']) {
  test(`a text argument holding ${JSON.stringify(lineBreak)} is refused by the parser as unsafe_text`, { criterion: 'AC-SPEC-32-03' }, () => {
    for (const argument of ['customerId', 'note', 'tag']) {
      const generated = { ...GENERATED[0], [argument]: `notes${lineBreak}Host: evil.example` };
      assert.deepEqual(rejection(parsePlan, callPlanOf([call('addCustomerNote', generated)])), [`unsafe_text $.steps[0].arguments.${argument}`]);
    }
  });
}

// ---- Values checked at run time --------------------------------------------------------------------------

const byName = (name: string) => ({ valueName: name });

test('a path segment of "", "." or ".." from a run value is refused with parameter-invalid', { criterion: 'AC-SPEC-32-03' }, () => {
  const callArguments = argumentsFor('addCustomerNote', { ...GENERATED[0], customerId: byName('customerKey') }, ['customerKey']);
  for (const text of ['.', '..']) {
    assert.equal(refusedBuild('addCustomerNote', callArguments, valuesOf({ customerKey: text })), 'parameter-invalid', JSON.stringify(text));
  }
});

type RunTimeCase = { readonly parameter: string; readonly bad: readonly string[]; readonly good: string };

// createOrder's parameters, each given a run value by name.
const RUN_TIME_CASES: readonly RunTimeCase[] = [
  { parameter: 'quantity', bad: ['twelve', '7.5', '0', '100', '', '0x1F', '1e1'], good: '12' },
  { parameter: 'contactEmail', bad: ['not-an-email', 'ada@', '@example.com', 'ada example.com'], good: 'ada@example.com' },
  { parameter: 'deliveryDay', bad: ['2026-02-30', '02.11.2026', '2026-11-2', 'tomorrow'], good: '2026-11-02' },
  { parameter: 'region', bad: ['antarctica', 'EU', 'eu '], good: 'us' },
  { parameter: 'giftWrap', bad: ['yes', 'maybe'], good: 'true' },
  { parameter: 'customerName', bad: ['x'.repeat(41)], good: 'x'.repeat(40) },
];

for (const runTime of RUN_TIME_CASES) {
  test(`a run value that fails ${runTime.parameter}'s type is refused with parameter-invalid`, { criterion: 'AC-SPEC-32-04' }, () => {
    const values = { kept: { kind: 'uniqueText', prefix: 'kept' } };
    const plan = accepted(parsePlan, callPlanOf([call('createOrder', orderArguments({ [runTime.parameter]: byName('kept') }))], { values }));
    for (const text of runTime.bad) {
      assert.equal(refusedBuild('createOrder', parsedArguments(plan), valuesOf({ kept: text })), 'parameter-invalid', `${runTime.parameter} ${JSON.stringify(text)}`);
    }
    // Counter-example: a value of the right type builds the request.
    built('createOrder', parsedArguments(plan), valuesOf({ kept: runTime.good }));
  });
}

test('an identifier parameter refuses a remembered value holding a hyphen, a space or a quote', { criterion: 'AC-SPEC-32-04' }, () => {
  const callArguments = argumentsFor('getOrder', { orderId: byName('orderKey') }, ['orderKey']);
  for (const text of ['order-17', 'ord 17', "ord_17'; DROP TABLE orders; --", '17abc', '']) {
    assert.equal(refusedBuild('getOrder', callArguments, valuesOf({ orderKey: text })), 'parameter-invalid', JSON.stringify(text));
  }
  assert.equal(pathOf(built('getOrder', callArguments, valuesOf({ orderKey: 'ord_17' }))), '/api/orders/ord_17');
});

test('a run value of the right type fills the request as a literal would', { criterion: 'AC-SPEC-32-04' }, () => {
  const byValue = argumentsFor('getOrder', { orderId: byName('orderKey') }, ['orderKey']);
  const literal = argumentsFor('getOrder', { orderId: 'ord_17' });
  assert.deepEqual(built('getOrder', byValue, valuesOf({ orderKey: 'ord_17' })), built('getOrder', literal));
});

// ---- Types in the body ---------------------------------------------------------------------------------

test('integers and booleans fill the body as JSON numbers and booleans, from literals or values', { criterion: 'AC-SPEC-32-03' }, () => {
  const fromLiterals = bodyJson(built('createOrder', argumentsFor('createOrder', orderArguments({ quantity: 3, giftWrap: true })))) as JsonRecord;
  assert.equal(fromLiterals.quantity, 3);
  assert.equal(fromLiterals.giftWrap, true);
  assert.equal(fromLiterals.reference, 'test-eu-3');
  const values = { count: { kind: 'uniqueNumber', digits: 4 } };
  const plan = accepted(parsePlan, callPlanOf([call('createOrder', orderArguments({ quantity: byName('count') }))], { values }));
  const fromValue = bodyJson(built('createOrder', parsedArguments(plan), valuesOf({ count: '42' }))) as JsonRecord;
  assert.equal(fromValue.quantity, 42);
  assert.equal(fromValue.reference, 'test-eu-42');
});

test('a call with no body sends none, and a GET carries only its declared headers', { criterion: 'AC-SPEC-32-03' }, () => {
  const request = built('getOrder', argumentsFor('getOrder', { orderId: 'ord_17' }));
  assert.equal(request.body, null);
  assert.deepEqual(headerNames(request), ['authorization']);
});

// ---- Limits carried to the caller -------------------------------------------------------------------------

test('a declaration that sets no limits gets a 10 s timeout and a 1 MiB response cap', { criterion: 'AC-SPEC-32-10' }, () => {
  const request = built('getOrder', argumentsFor('getOrder', { orderId: 'ord_17' }));
  assert.equal(request.timeoutMilliseconds, 10_000);
  assert.equal(request.maximumResponseBytes, 1024 * 1024);
});

test('a declaration\'s own timeout and response cap reach the request', { criterion: 'AC-SPEC-32-10' }, () => {
  const request = built('addCustomerNote', argumentsFor('addCustomerNote', GENERATED[1] ?? assert.fail('no generated set')));
  assert.equal(request.timeoutMilliseconds, 2500);
  assert.equal(request.maximumResponseBytes, 4096);
});

// ---- Secrets ---------------------------------------------------------------------------------------------

test('a bearer header carries the token as an opaque secret, never as plain text', { criterion: 'AC-SPEC-32-11' }, () => {
  const request = built('getOrder', argumentsFor('getOrder', { orderId: 'ord_17' }));
  const header = headerNamed(request, 'authorization');
  assert.ok(header !== undefined && typeof header.value !== 'string', 'the secret header is not plain text');
  assert.equal(reveal(header.value), `Bearer ${SECRET_VALUES[TOKEN_SECRET]}`);
  assert.ok(!JSON.stringify(request).includes(SECRET_VALUES[TOKEN_SECRET] ?? '?'), 'the request serialises its secret');
});

test('a basic header carries "user:password" base64-encoded, inside an opaque secret', { criterion: 'AC-SPEC-32-11' }, () => {
  const request = built('resetShop', argumentsFor('resetShop', {}));
  const header = headerNamed(request, 'authorization');
  assert.ok(header !== undefined && typeof header.value !== 'string', 'the secret header is not plain text');
  assert.equal(reveal(header.value), `Basic ${Buffer.from(SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '').toString('base64')}`);
  const serialised = JSON.stringify(request);
  assert.ok(!serialised.includes(Buffer.from(SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '').toString('base64')), 'the request serialises its secret');
});

test('a header secret the store cannot resolve is refused with secret-missing', { criterion: 'AC-SPEC-32-12' }, () => {
  const store = environmentSecretStore({ [ADMIN_LOGIN_SECRET]: SECRET_VALUES[ADMIN_LOGIN_SECRET] ?? '' });
  assert.equal(refusedBuild('getOrder', argumentsFor('getOrder', { orderId: 'ord_17' }), NO_VALUES, store), 'secret-missing');
});

test('a secret argument the store cannot resolve is refused with secret-missing', { criterion: 'AC-SPEC-32-12' }, () => {
  const store = environmentSecretStore({ [TOKEN_SECRET]: SECRET_VALUES[TOKEN_SECRET] ?? '' });
  const callArguments = argumentsFor('signInAsAdmin', { adminPassword: { secretName: ADMIN_PASSWORD_SECRET } });
  assert.equal(refusedBuild('signInAsAdmin', callArguments, NO_VALUES, store), 'secret-missing');
});

// ---- Purity ----------------------------------------------------------------------------------------------

test('the same declaration, arguments, values and secrets always build the same request', { criterion: 'AC-SPEC-32-03' }, () => {
  const callArguments = argumentsFor('addCustomerNote', GENERATED[2] ?? assert.fail('no generated set'));
  const first = built('addCustomerNote', callArguments);
  const second = built('addCustomerNote', callArguments);
  assert.deepEqual({ ...first, headers: headerNames(first) }, { ...second, headers: headerNames(second) });
  assert.deepEqual(bodyJson(first), bodyJson(second));
});

test('a token header sends the secret\'s value as it is, inside an opaque secret', { criterion: 'AC-SPEC-32-11' }, () => {
  const tokenCall = {
    service: 'shop', method: 'GET', path: '/api/orders/{orderId}', headers: { 'x-api-key': { secretName: TOKEN_SECRET, scheme: 'token' } },
    parameters: { orderId: { kind: 'identifier' } }, effect: 'read', successStatuses: [200],
  };
  const tokenProject = callProject({ getOrderByKey: tokenCall });
  const declaration = declarationOf(tokenProject, 'getOrderByKey');
  const callArguments = parsedArguments(accepted(callParser({ getOrderByKey: tokenCall }), callPlanOf([call('getOrderByKey', { orderId: 'ord_17' })])));
  const outcome = buildServiceRequest(declaration, serviceOf(tokenProject, declaration.service), callArguments, NO_VALUES, secrets);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const header = headerNamed(outcome.value, 'x-api-key');
  assert.ok(header !== undefined && typeof header.value !== 'string', 'the secret header is not plain text');
  assert.equal(reveal(header.value), SECRET_VALUES[TOKEN_SECRET]);
});
