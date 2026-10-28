// Shared setup for the tests of declared network stubs, request checks and web storage: powers the
// trusted project declares under `stubs`, `observedRequests` and `storageEntries`, and that a plan
// may only use by name, with arguments typed by the declaration.
//
//   - stubProjectFile() is the shared test project (plan-examples.ts) with the fixture files and
//     the declarations below. The shop service it already declares lets a matcher name the
//     service's origin, which is not on the allow-list;
//   - startStub(), resetRequests(), expectRequests(), expectResponse(), rememberResponse(),
//     setStorage(), removeStorage() and expectStorage() build the plan steps that name them;
//   - sectionOf() and fieldOf() read the parsed project's new sections without naming their
//     types, so a test reads what the parser kept, whatever shape the types take.
//
// The steps and declarations follow the shapes in the spec's "Interfaces and types".
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { parseProject, planParser, type Project } from '@revisum/engine';
import {
  NEW_VERSION, ORIGIN, TARGET_ID, planOf, projectFileWith, type JsonRecord, type ParsePlan,
} from './run-value-examples.ts';

export { NEW_VERSION, ORIGIN, TARGET_ID, planOf, type JsonRecord };

// The shared test project's shop service: a declared service, so a matcher may name its origin.
export const SHOP_ORIGIN = 'http://127.0.0.1:4180';
// An origin that is neither on the allow-list nor any declared service's.
export const UNDECLARED_ORIGIN = 'https://cdn.example.net';

// Files in the project's fixtures folder that a stub may serve.
export const FIXTURE_FILES = ['save-failed.json', 'totp-required.json'];

// A secret the shared test project declares, which a secret storage parameter may name.
export const TOKEN_SECRET = 'SHOP_API_TOKEN';

export const matcher = (origin: string, method: string, path: string, match: 'exact' | 'prefix'): JsonRecord =>
  ({ origin, method, path, match });

// ---- The declarations, as a person writes them in project.json ----------------------------------

export const STUBS: JsonRecord = {
  // A login that first asks for a one-time code, then succeeds: two responses, the last repeating.
  // Its first response carries a reason the plan gives.
  loginNeedsCode: {
    request: matcher(ORIGIN, 'POST', '/api/v1/login', 'exact'),
    parameters: { reason: { kind: 'text', maximumLength: 80 } },
    responses: [
      {
        status: 401, mediaType: 'application/json', headers: { 'x-request-id': 'stub-login-1' },
        body: { json: { error: 'totp-required', message: { $parameter: 'reason' } } },
      },
      { status: 200, mediaType: 'application/json', body: { json: { status: 'success' } } },
    ],
    allowInProposals: true,
  },
  // An autosave that fails, served from a declared fixture file. Not allowed in proposals.
  saveFails: {
    request: matcher(ORIGIN, 'POST', '/wp-json/wp/v2/posts', 'prefix'),
    parameters: {},
    responses: [{ status: 500, mediaType: 'application/problem+json', body: { fixture: 'save-failed.json' } }],
    allowInProposals: false,
  },
  // A CSV export on the shop service's origin, answered with plain text.
  ordersExport: {
    request: matcher(SHOP_ORIGIN, 'GET', '/api/orders.csv', 'exact'),
    parameters: {},
    responses: [{ status: 200, mediaType: 'text/csv', headers: { 'cache-control': 'no-store' }, body: { text: 'id,total' } }],
    allowInProposals: true,
  },
  // An empty cart: no body at all.
  cartEmpty: {
    request: matcher(ORIGIN, 'GET', '/api/cart', 'exact'),
    parameters: {},
    responses: [{ status: 204, mediaType: 'text/plain', body: null }],
    allowInProposals: true,
  },
};

export const OBSERVED_REQUESTS: JsonRecord = {
  // The likes of a transaction, with three response fields a plan may read. On the allowed origin,
  // so the shared test project's copy parses even for a test that removes the services.
  likes: {
    request: matcher(ORIGIN, 'GET', '/api/transactions/likes', 'exact'),
    fields: { likeList: '/results', firstLiker: '/results/0/name', errorCode: '/code' },
    maximumResponseBytes: 65_536,
  },
  // Loads of a schedule: counted only, so no field and no body is kept.
  scheduleLoads: { request: matcher(ORIGIN, 'GET', '/api/schedule', 'prefix') },
};

export const STORAGE_ENTRIES: JsonRecord = {
  // A docked menu, written as JSON from a boolean parameter. Allowed in proposals.
  pinnedMenu: {
    area: 'local', origin: ORIGIN, key: 'grafana.navigation.docked', access: 'readWrite',
    value: { $parameter: 'docked' }, parameters: { docked: { kind: 'boolean' } }, allowInProposals: true,
  },
  // A dismissed welcome banner: a fixed string, so no parameters. Not allowed in proposals.
  welcomeDismissed: {
    area: 'local', origin: ORIGIN, key: 'welcome.dismissed', access: 'readWrite', value: 'yes', allowInProposals: false,
  },
  // A session token from a declared secret.
  sessionToken: {
    area: 'session', origin: ORIGIN, key: 'auth.token', access: 'readWrite',
    value: { $parameter: 'token' }, parameters: { token: { kind: 'secret' } }, allowInProposals: false,
  },
  // A key the app keeps, which a plan may only check.
  privateKey: { area: 'local', origin: ORIGIN, key: 'E2E.priv_key', access: 'read', allowInProposals: false },
};

export type Declarations = {
  readonly stubs?: JsonRecord;
  readonly observedRequests?: JsonRecord;
  readonly storageEntries?: JsonRecord;
};

// The shared test project with the fixture files and the declarations above. `declarations` adds
// or replaces declarations by name; `fields` adds or replaces other top-level fields.
export const stubProjectFile = (
  declarations: Declarations = {}, limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {},
): JsonRecord => projectFileWith({
  fixtures: FIXTURE_FILES,
  stubs: { ...STUBS, ...declarations.stubs },
  observedRequests: { ...OBSERVED_REQUESTS, ...declarations.observedRequests },
  storageEntries: { ...STORAGE_ENTRIES, ...declarations.storageEntries },
  ...fields,
}, limits);

export function stubProject(declarations: Declarations = {}, limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): Project {
  const parsed = parseProject(stubProjectFile(declarations, limits, fields));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const stubParser = (): ParsePlan => planParser(stubProject());

// A deep copy of a declaration above, for a test to change one thing in.
export const copyOf = (section: JsonRecord, name: string): JsonRecord => {
  const found = section[name];
  assert.ok(typeof found === 'object' && found !== null, `no declaration named ${name}`);
  return structuredClone(found) as JsonRecord;
};

// ---- Reading what the parser kept ------------------------------------------------------------------

export type Section = 'stubs' | 'observedRequests' | 'storageEntries';

// One of the parsed project's new sections, by declaration name.
export function sectionOf(project: object, section: Section): Readonly<Record<string, unknown>> {
  const fields: Readonly<Record<string, unknown>> = { ...project };
  const found = fields[section];
  assert.ok(typeof found === 'object' && found !== null && !Array.isArray(found), `the project has no ${section} section: ${JSON.stringify(found)}`);
  return { ...found };
}

// A field of a parsed declaration, or of any parsed object.
export function fieldOf(value: unknown, key: string): unknown {
  assert.ok(typeof value === 'object' && value !== null, `not an object: ${JSON.stringify(value)}`);
  const fields: Readonly<Record<string, unknown>> = { ...value };
  return fields[key];
}

// A parsed value as plain JSON, to compare with what a person wrote.
export const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// ---- Plan steps ----------------------------------------------------------------------------------

export const startStub = (name: unknown, stubArguments?: unknown): JsonRecord =>
  ({ type: 'stub', stub: name, action: 'start', ...(stubArguments === undefined ? {} : { arguments: stubArguments }) });
export const stopStub = (name: unknown): JsonRecord => ({ type: 'stub', stub: name, action: 'stop' });

export const resetRequests = (name: unknown): JsonRecord => ({ type: 'resetRequests', request: name });
export const expectRequests = (name: unknown, count: unknown): JsonRecord =>
  ({ type: 'expectRequests', request: name, count, criterionId: 'likes.request-count' });
export const expectResponse = (name: unknown, assertion: unknown): JsonRecord =>
  ({ type: 'expectResponse', request: name, assert: assertion, criterionId: 'likes.response-shown' });
export const rememberResponse = (valueName: unknown, request: unknown, field: unknown, read: unknown): JsonRecord =>
  ({ type: 'remember', name: valueName, from: { response: request, field, read } });

export const setStorage = (entry: unknown, entryArguments?: unknown): JsonRecord =>
  ({ type: 'setStorage', entry, ...(entryArguments === undefined ? {} : { arguments: entryArguments }) });
export const removeStorage = (entry: unknown): JsonRecord => ({ type: 'removeStorage', entry });
export const expectStorage = (entry: unknown, assertion: unknown): JsonRecord =>
  ({ type: 'expectStorage', entry, assert: assertion, criterionId: 'menu.docking-kept' });
