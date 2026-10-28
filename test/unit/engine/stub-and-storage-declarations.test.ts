// Stub, request-check and storage declarations in the trusted project file. A person declares each
// stub (a request matcher and the responses served in order), each observed request (a matcher and
// the response fields a plan may read) and each storage entry (area, origin, key and access). The
// project parser refuses a matcher on an origin that is neither allowed nor a declared service's,
// a stub header that could change how the browser treats the response, a media type that could
// carry code, and a fixture the project does not declare. Each case below changes one thing in a
// declaration the parser accepts, so the refusal comes from that change. The new limit
// requestQuietMilliseconds is read here too. And a declaration added or changed by the change
// under test is never trusted: the protected branch's project.json is used, and the edit raises a
// changed-with-code review item.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject, type TrustedProject } from '@revisum/engine';
import { PROJECT_PATH, loadForChange, memoryEventSink, withRepository, type FixtureRepository } from './approval-repositories.ts';
import { projectRefusal } from './service-call-examples.ts';
import {
  OBSERVED_REQUESTS, ORIGIN, SHOP_ORIGIN, STORAGE_ENTRIES, STUBS, UNDECLARED_ORIGIN, asJson, copyOf, fieldOf, matcher, sectionOf,
  stubProject, stubProjectFile, type Declarations, type JsonRecord,
} from './stub-and-storage-examples.ts';

const accepts = (projectFile: JsonRecord): void => {
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, JSON.stringify(parsed));
};

// The shared stub loginNeedsCode with its first response changed by `changes`.
const loginWithFirstResponse = (changes: JsonRecord): JsonRecord => {
  const stub = copyOf(STUBS, 'loginNeedsCode');
  const responses = stub['responses'] as JsonRecord[];
  responses[0] = { ...responses[0], ...changes };
  return stub;
};
const withStub = (name: string, declaration: JsonRecord): JsonRecord => stubProjectFile({ stubs: { [name]: declaration } });
const withObserved = (name: string, declaration: JsonRecord): JsonRecord => stubProjectFile({ observedRequests: { [name]: declaration } });
const withEntry = (name: string, declaration: JsonRecord): JsonRecord => stubProjectFile({ storageEntries: { [name]: declaration } });

// Every error at this path or inside it, and at least one.
function assertRefusedInside(errors: readonly string[], path: string, label = path): void {
  assert.ok(errors.length > 0, label);
  for (const error of errors) {
    const found = error.split(' ')[1] ?? '';
    assert.ok(found === path || found.startsWith(`${path}.`) || found.startsWith(`${path}[`), `${label}: ${JSON.stringify(errors)}`);
  }
}

// ---- The declarations the parser accepts ---------------------------------------------------------

test('the shared stub, request and storage declarations parse, and the project keeps each by name', { criterion: 'AC-SPEC-33-01' }, () => {
  const project = stubProject();
  assert.deepEqual(Object.keys(sectionOf(project, 'stubs')).sort(), Object.keys(STUBS).sort());
  assert.deepEqual(Object.keys(sectionOf(project, 'observedRequests')).sort(), Object.keys(OBSERVED_REQUESTS).sort());
  assert.deepEqual(Object.keys(sectionOf(project, 'storageEntries')).sort(), Object.keys(STORAGE_ENTRIES).sort());
});

test('a parsed stub keeps its matcher and its responses in the order declared', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = sectionOf(stubProject(), 'stubs')['loginNeedsCode'];
  assert.deepEqual(asJson(fieldOf(stub, 'request')), matcher(ORIGIN, 'POST', '/api/v1/login', 'exact'));
  const responses = fieldOf(stub, 'responses');
  assert.ok(Array.isArray(responses), JSON.stringify(stub));
  assert.deepEqual(responses.map((response) => [fieldOf(response, 'status'), fieldOf(response, 'mediaType')]), [[401, 'application/json'], [200, 'application/json']]);
});

test('a project with no stubs, observedRequests or storageEntries section declares none', { criterion: 'AC-SPEC-33-01' }, () => {
  const parsed = parseProject(stubProjectFile({}, {}, { fixtures: undefined, stubs: undefined, observedRequests: undefined, storageEntries: undefined }));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  for (const section of ['stubs', 'observedRequests', 'storageEntries'] as const) assert.deepEqual(sectionOf(parsed.value, section), {}, section);
});

// ---- Matcher origins -------------------------------------------------------------------------------

test('a stub on an origin neither allowed nor a declared service is refused with origin_not_allowed at its origin', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = { ...copyOf(STUBS, 'loginNeedsCode'), request: matcher(UNDECLARED_ORIGIN, 'POST', '/api/v1/login', 'exact') };
  assert.deepEqual(projectRefusal(withStub('loginNeedsCode', stub)), ['origin_not_allowed $.stubs.loginNeedsCode.request.origin']);
});

test('an observed request on an origin neither allowed nor a declared service is refused with origin_not_allowed', { criterion: 'AC-SPEC-33-01' }, () => {
  const observed = { ...copyOf(OBSERVED_REQUESTS, 'scheduleLoads'), request: matcher(UNDECLARED_ORIGIN, 'GET', '/api/schedule', 'prefix') };
  assert.deepEqual(projectRefusal(withObserved('scheduleLoads', observed)), ['origin_not_allowed $.observedRequests.scheduleLoads.request.origin']);
});

// Counter-examples: an allowed origin and a declared service's origin are both accepted.
test('a stub on an allowed origin, and one on a declared service\'s origin, are accepted', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const origin of [ORIGIN, SHOP_ORIGIN]) {
    accepts(withStub('cartEmpty', { ...copyOf(STUBS, 'cartEmpty'), request: matcher(origin, 'GET', '/api/cart', 'exact') }));
  }
});

// Mutant: a parser that trusts any loopback origin would accept this. With no services declared
// (and so no calls), the shop's origin is just another undeclared origin.
test('a stub on the shop\'s origin is refused once the project no longer declares the shop service', { criterion: 'AC-SPEC-33-01' }, () => {
  const projectFile = stubProjectFile(
    {}, {},
    { services: undefined, calls: undefined, stubs: { ordersExport: copyOf(STUBS, 'ordersExport') }, observedRequests: {}, storageEntries: {} },
  );
  assert.deepEqual(projectRefusal(projectFile), ['origin_not_allowed $.stubs.ordersExport.request.origin']);
});

test('a storage entry on an origin the project does not allow is refused with origin_not_allowed at its origin', { criterion: 'AC-SPEC-33-01' }, () => {
  const errors = projectRefusal(withEntry('privateKey', { ...copyOf(STORAGE_ENTRIES, 'privateKey'), origin: UNDECLARED_ORIGIN }));
  assert.deepEqual(errors, ['origin_not_allowed $.storageEntries.privateKey.origin']);
});

// Counter-example: an observed request may name a declared service's origin, as a stub may.
test('an observed request on a declared service\'s origin is accepted', { criterion: 'AC-SPEC-33-01' }, () => {
  accepts(withObserved('likes', { ...copyOf(OBSERVED_REQUESTS, 'likes'), request: matcher(SHOP_ORIGIN, 'GET', '/api/transactions/likes', 'exact') }));
});

// ---- Stub response headers ------------------------------------------------------------------------

const DENIED_HEADERS = [
  'set-cookie', 'location', 'refresh', 'content-type', 'content-length', 'transfer-encoding', 'link', 'clear-site-data',
  'content-security-policy', 'content-security-policy-report-only',
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cross-origin-embedder-policy',
  'permissions-policy', 'strict-transport-security', 'service-worker-allowed', 'report-to', 'nel',
  'Set-Cookie', 'Content-Type', 'ACCESS-CONTROL-ALLOW-ORIGIN', 'Service-Worker-Allowed',
  // The engine always sends nosniff itself, so a declaration may not set it, or weaken it.
  'x-content-type-options', 'X-Content-Type-Options',
];

for (const header of DENIED_HEADERS) {
  test(`a stub response setting the header "${header}" is refused with header_not_allowed at that header`, { criterion: 'AC-SPEC-33-01' }, () => {
    const stub = loginWithFirstResponse({ headers: { 'x-request-id': 'stub-login-1', [header]: 'value-for-the-test' } });
    assert.deepEqual(projectRefusal(withStub('loginNeedsCode', stub)), [`header_not_allowed $.stubs.loginNeedsCode.responses[0].headers.${header}`]);
  });
}

test('a denied header on a later response is refused at that response', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = copyOf(STUBS, 'loginNeedsCode');
  const responses = stub['responses'] as JsonRecord[];
  responses[1] = { ...responses[1], headers: { location: '/admin' } };
  assert.deepEqual(projectRefusal(withStub('loginNeedsCode', stub)), ['header_not_allowed $.stubs.loginNeedsCode.responses[1].headers.location']);
});

// Counter-example: ordinary response headers are accepted.
test('cache-control, retry-after and x- headers are accepted on a stub response', { criterion: 'AC-SPEC-33-01' }, () => {
  accepts(withStub('loginNeedsCode', loginWithFirstResponse({ headers: { 'cache-control': 'no-store', 'retry-after': '30', 'x-request-id': 'stub-login-1' } })));
});

test('a stub header value holding a line break is refused, so no header can be smuggled in', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const value of ['stub\r\nSet-Cookie: session=1', 'stub\nLocation: /admin']) {
    const errors = projectRefusal(withStub('loginNeedsCode', loginWithFirstResponse({ headers: { 'x-request-id': value } })));
    assert.deepEqual(errors, ['unsafe_text $.stubs.loginNeedsCode.responses[0].headers.x-request-id'], JSON.stringify(value));
  }
});

// ---- Stub media types ------------------------------------------------------------------------------

const CODE_OR_MARKUP_TYPES = [
  'text/html', 'application/javascript', 'text/javascript', 'text/css', 'image/svg+xml', 'application/wasm',
  'application/xhtml+xml', 'application/xml', 'image/png', 'application/octet-stream', 'application/json; charset=utf-8',
];

for (const mediaType of CODE_OR_MARKUP_TYPES) {
  test(`a stub response served as "${mediaType}" is refused with unknown_value at its media type`, { criterion: 'AC-SPEC-33-01' }, () => {
    assert.deepEqual(projectRefusal(withStub('loginNeedsCode', loginWithFirstResponse({ mediaType }))), ['unknown_value $.stubs.loginNeedsCode.responses[0].mediaType']);
  });
}

// Counter-example: each of the four data media types is accepted.
test('application/json, application/problem+json, text/plain and text/csv are accepted', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const mediaType of ['application/json', 'application/problem+json', 'text/plain', 'text/csv']) {
    accepts(withStub('cartEmpty', { ...copyOf(STUBS, 'cartEmpty'), responses: [{ status: 200, mediaType, body: { text: 'ok' } }] }));
  }
});

// ---- Stub bodies -----------------------------------------------------------------------------------

test('a stub body naming a fixture the project does not declare is refused with unknown_value at the fixture', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = { ...copyOf(STUBS, 'saveFails'), responses: [{ status: 500, mediaType: 'application/json', body: { fixture: 'not-declared.json' } }] };
  assert.deepEqual(projectRefusal(withStub('saveFails', stub)), ['unknown_value $.stubs.saveFails.responses[0].body.fixture']);
});

test('a stub body naming a fixture outside the fixtures folder is refused at the fixture', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const fixture of ['../project.json', 'nested/save-failed.json']) {
    const stub = { ...copyOf(STUBS, 'saveFails'), responses: [{ status: 500, mediaType: 'application/json', body: { fixture } }] };
    assertRefusedInside(projectRefusal(withStub('saveFails', stub)), '$.stubs.saveFails.responses[0].body.fixture', fixture);
  }
});

// Counter-example: the same stub serving a declared fixture is accepted (saveFails as shared).
test('a stub body naming a declared fixture is accepted', { criterion: 'AC-SPEC-33-01' }, () => {
  const parsed = parseProject(stubProjectFile());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(asJson(fieldOf((fieldOf(sectionOf(parsed.value, 'stubs')['saveFails'], 'responses') as unknown[])[0], 'body')), { fixture: 'save-failed.json' });
});

test('a JSON body naming a parameter the stub does not declare is refused with unknown_value', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = loginWithFirstResponse({ body: { json: { error: { $parameter: 'errorCode' }, message: { $parameter: 'reason' } } } });
  assertRefusedInside(projectRefusal(withStub('loginNeedsCode', stub)), '$.stubs.loginNeedsCode.responses[0].body');
  assert.deepEqual(projectRefusal(withStub('loginNeedsCode', stub)).map((error) => error.split(' ')[0]), ['unknown_value']);
});

test('a stub declaration field the format does not have, such as a script, is refused with unknown_field', { criterion: 'AC-SPEC-33-01' }, () => {
  assert.deepEqual(projectRefusal(withStub('cartEmpty', { ...copyOf(STUBS, 'cartEmpty'), script: 'window.stubbed = true' })), ['unknown_field $.stubs.cartEmpty.script']);
  assert.deepEqual(
    projectRefusal(withStub('cartEmpty', { ...copyOf(STUBS, 'cartEmpty'), responses: [{ status: 204, mediaType: 'text/plain', body: null, html: '<p>' }] })),
    ['unknown_field $.stubs.cartEmpty.responses[0].html'],
  );
});

// ---- The rest of a stub ----------------------------------------------------------------------------

test('a stub with no responses is refused with empty, and one with more than 20 with too_large', { criterion: 'AC-SPEC-33-01' }, () => {
  const response = { status: 204, mediaType: 'text/plain', body: null };
  const withResponses = (count: number) => withStub('cartEmpty', { ...copyOf(STUBS, 'cartEmpty'), responses: Array.from({ length: count }, () => response) });
  assert.deepEqual(projectRefusal(withResponses(0)), ['empty $.stubs.cartEmpty.responses']);
  assert.deepEqual(projectRefusal(withResponses(21)), ['too_large $.stubs.cartEmpty.responses']);
  accepts(withResponses(20));
});

test('a stub status outside 200 to 599 is refused with unknown_value at the status', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const status of [100, 199, 600, 1000]) {
    assert.deepEqual(projectRefusal(withStub('loginNeedsCode', loginWithFirstResponse({ status }))), ['unknown_value $.stubs.loginNeedsCode.responses[0].status'], String(status));
  }
  for (const status of [200, 599]) accepts(withStub('loginNeedsCode', loginWithFirstResponse({ status })));
});

test('a stub status that is not a whole number is refused with wrong_type at the status', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const status of [200.5, '200', null]) {
    assert.deepEqual(projectRefusal(withStub('loginNeedsCode', loginWithFirstResponse({ status }))), ['wrong_type $.stubs.loginNeedsCode.responses[0].status'], JSON.stringify(status));
  }
});

test('a matcher method outside the declared list, or a match other than exact or prefix, is refused with unknown_value', { criterion: 'AC-SPEC-33-01' }, () => {
  const stub = copyOf(STUBS, 'cartEmpty');
  assert.deepEqual(projectRefusal(withStub('cartEmpty', { ...stub, request: matcher(ORIGIN, 'OPTIONS', '/api/cart', 'exact') })), ['unknown_value $.stubs.cartEmpty.request.method']);
  assert.deepEqual(projectRefusal(withStub('cartEmpty', { ...stub, request: { ...matcher(ORIGIN, 'GET', '/api/cart', 'exact'), match: 'regex' } })), ['unknown_value $.stubs.cartEmpty.request.match']);
});

test('a matcher path that does not start with "/" is refused at the path', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const path of ['api/cart', 'https://cdn.example.net/api/cart', '']) {
    const stub = { ...copyOf(STUBS, 'cartEmpty'), request: matcher(ORIGIN, 'GET', path, 'exact') };
    assertRefusedInside(projectRefusal(withStub('cartEmpty', stub)), '$.stubs.cartEmpty.request.path', JSON.stringify(path));
  }
});

test('a stub, request or storage entry name outside the pattern is refused with unknown_value at the name', { criterion: 'AC-SPEC-33-01' }, () => {
  assert.deepEqual(projectRefusal(stubProjectFile({ stubs: { 'Login-Stub': copyOf(STUBS, 'cartEmpty') } })), ['unknown_value $.stubs.Login-Stub']);
  assert.deepEqual(projectRefusal(stubProjectFile({ observedRequests: { 'schedule_loads': copyOf(OBSERVED_REQUESTS, 'scheduleLoads') } })), ['unknown_value $.observedRequests.schedule_loads']);
  assert.deepEqual(projectRefusal(stubProjectFile({ storageEntries: { '1menu': copyOf(STORAGE_ENTRIES, 'privateKey') } })), ['unknown_value $.storageEntries.1menu']);
});

// ---- Observed requests ------------------------------------------------------------------------------

test('an observed field that is not a JSON pointer is refused with unknown_value at the field', { criterion: 'AC-SPEC-33-01' }, () => {
  const observed = { ...copyOf(OBSERVED_REQUESTS, 'likes'), fields: { likeList: 'results' } };
  assert.deepEqual(projectRefusal(withObserved('likes', observed)), ['unknown_value $.observedRequests.likes.fields.likeList']);
});

test('an observed request without maximumResponseBytes keeps at most 256 KiB of a body', { criterion: 'AC-SPEC-33-08' }, () => {
  const observed = sectionOf(stubProject(), 'observedRequests');
  assert.equal(fieldOf(observed['scheduleLoads'], 'maximumResponseBytes'), 256 * 1024);
  assert.equal(fieldOf(observed['likes'], 'maximumResponseBytes'), 65_536);
});

// ---- Storage entries --------------------------------------------------------------------------------

test('a storage area other than local or session, or an access other than read or readWrite, is refused with unknown_value', { criterion: 'AC-SPEC-33-01' }, () => {
  for (const area of ['cookie', 'indexedDb', 'cache']) {
    assert.deepEqual(projectRefusal(withEntry('privateKey', { ...copyOf(STORAGE_ENTRIES, 'privateKey'), area })), ['unknown_value $.storageEntries.privateKey.area'], area);
  }
  for (const access of ['write', 'readwrite', 'delete']) {
    assert.deepEqual(projectRefusal(withEntry('privateKey', { ...copyOf(STORAGE_ENTRIES, 'privateKey'), access })), ['unknown_value $.storageEntries.privateKey.access'], access);
  }
});

test('a value template on a read entry is refused with unknown_field at the value', { criterion: 'AC-SPEC-33-01' }, () => {
  const errors = projectRefusal(withEntry('privateKey', { ...copyOf(STORAGE_ENTRIES, 'privateKey'), value: 'planted-key' }));
  assert.deepEqual(errors, ['unknown_field $.storageEntries.privateKey.value']);
});

test('a storage value template naming a parameter the entry does not declare is refused with unknown_value', { criterion: 'AC-SPEC-33-01' }, () => {
  const errors = projectRefusal(withEntry('pinnedMenu', { ...copyOf(STORAGE_ENTRIES, 'pinnedMenu'), value: { docked: { $parameter: 'docked' }, width: { $parameter: 'width' } } }));
  assertRefusedInside(errors, '$.storageEntries.pinnedMenu.value');
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['unknown_value']);
});

// ---- The quiet window ------------------------------------------------------------------------------

const limitsOf = (limits: Readonly<Record<string, number>> = {}): Readonly<Record<string, unknown>> => stubProject({}, limits).limits;

test('a project that sets no quiet window waits 500 ms with no matching request in flight', { criterion: 'AC-SPEC-33-07' }, () => {
  assert.equal(limitsOf()['requestQuietMilliseconds'], 500);
});

test('requestQuietMilliseconds may be up to 5000, and over it is refused at the limit', { criterion: 'AC-SPEC-33-07' }, () => {
  assert.equal(limitsOf({ requestQuietMilliseconds: 5000 })['requestQuietMilliseconds'], 5000);
  const errors = projectRefusal(stubProjectFile({}, { requestQuietMilliseconds: 5001 }));
  assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.limits.requestQuietMilliseconds']);
  assert.notEqual(errors[0]?.split(' ')[0], 'unknown_field', 'requestQuietMilliseconds is a known limit');
});

// ---- Declarations edited by the change under test ----------------------------------------------------

const APPLICATION_CODE = 'src/login.ts';
const APPLICATION_SOURCE = 'export const login = () => fetch("/api/v1/login", { method: "POST" });\n';

type Edit = { readonly name: string; readonly declarations: Declarations; readonly trusted: (project: TrustedProject) => void };

// Each change edits application code and, in its own project.json, one kind of declaration.
const EDITS: readonly Edit[] = [
  {
    name: 'adds a stub',
    declarations: { stubs: { paymentAccepted: { ...copyOf(STUBS, 'cartEmpty'), request: matcher(ORIGIN, 'POST', '/api/payments', 'prefix'), allowInProposals: true } } },
    trusted: (project) => assert.deepEqual(Object.keys(sectionOf(project, 'stubs')).sort(), Object.keys(STUBS).sort()),
  },
  {
    name: 'edits a stub to be allowed in proposals',
    declarations: { stubs: { saveFails: { ...copyOf(STUBS, 'saveFails'), allowInProposals: true } } },
    trusted: (project) => assert.equal(fieldOf(sectionOf(project, 'stubs')['saveFails'], 'allowInProposals'), false),
  },
  {
    name: 'edits a request check to read another field',
    declarations: { observedRequests: { likes: { ...copyOf(OBSERVED_REQUESTS, 'likes'), fields: { likeList: '/results', sessionCookie: '/session' } } } },
    trusted: (project) => assert.deepEqual(Object.keys(asJson(fieldOf(sectionOf(project, 'observedRequests')['likes'], 'fields')) as JsonRecord).sort(), ['errorCode', 'firstLiker', 'likeList']),
  },
  {
    name: 'edits a storage entry from read to readWrite',
    declarations: { storageEntries: { privateKey: { ...copyOf(STORAGE_ENTRIES, 'privateKey'), access: 'readWrite', value: 'planted-key', allowInProposals: true } } },
    trusted: (project) => assert.equal(fieldOf(sectionOf(project, 'storageEntries')['privateKey'], 'access'), 'read'),
  },
];

const editing = (declarations: Declarations) => (fixture: FixtureRepository): void => {
  fixture.protectedFiles[PROJECT_PATH] = stubProjectFile();
  fixture.workingCopy[PROJECT_PATH] = stubProjectFile(declarations);
  fixture.workingCopy[APPLICATION_CODE] = APPLICATION_SOURCE;
};

for (const edit of EDITS) {
  test(`when the change ${edit.name}, the run uses the protected-branch declarations and raises changed-with-code`, { criterion: 'AC-SPEC-33-13' }, async () => {
    await withRepository('solo', async (repository) => {
      const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
      assert.ok(loaded.ok, JSON.stringify(loaded));
      edit.trusted(loaded.value.project);
      assert.equal(loaded.value.project.provenance.kind, 'protected-branch');
      assert.deepEqual(loaded.value.reviewItems, [{ code: 'changed-with-code', path: PROJECT_PATH }]);
    }, editing(edit.declarations));
  });
}

// Counter-example: the same protected project, with a change that leaves project.json alone,
// raises no review item, and the protected declarations are the ones in force.
test('a change that does not touch project.json raises no review item, and the protected declarations hold', { criterion: 'AC-SPEC-33-13' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [APPLICATION_CODE], memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.deepEqual(loaded.value.reviewItems, []);
    assert.equal(fieldOf(sectionOf(loaded.value.project, 'storageEntries')['privateKey'], 'access'), 'read');
  }, (fixture) => {
    fixture.protectedFiles[PROJECT_PATH] = stubProjectFile();
    fixture.workingCopy[APPLICATION_CODE] = APPLICATION_SOURCE;
  });
});
