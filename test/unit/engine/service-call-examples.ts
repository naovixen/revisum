// Shared setup for the tests of declared service calls: named HTTP calls that the trusted project
// declares under `calls`, and that a plan may only invoke by name with typed arguments.
//
//   - callProjectFile() is the shared test project (plan-examples.ts) with one declared service,
//     the secrets its calls use and the call declarations below;
//   - call(), expectBackend() and withCleanup() build the plan parts that name a declaration;
//   - fakeServiceCaller() stands in for runner's ServiceCaller. It records every request it is
//     handed and answers from a route the test gives, so no request leaves the process;
//   - runWithCalls() parses a plan, clears it through the policy gate and runs it with the fake
//     caller as the run's `services` port, on a driver that needs no browser, under a virtual
//     clock whose sleep returns at once, so polling for a backend check costs no real time.
//
// What these tests assume about shapes the spec leaves open is gathered here, so a change to the
// interface is a change to one file:
//   - the project file lists services as SPEC-02 describes them: { name, origin, private };
//   - a run's cleanup calls are recorded in RunResult.cleanup, one record per cleanup call in
//     order, each with an `outcome` (passed, failed or skipped) and, on failure, a `code`;
//   - a review item a run raises is in RunResult.reviewItems, each with a `code`.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import {
  defaultRedactor, environmentSecretStore, failure, parseProject, planParser, run, success,
  type Clock, type LoggedEvent, type PlanStanding, type Project, type Result, type RunResult,
  type ServiceCallErrorCode, type ServiceCaller, type ServiceRequest, type ServiceResponse,
} from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import {
  DEFAULT_CLOCK_START, DEFAULT_SEED, NEW_VERSION, ORIGIN, TARGET_ID, accepted, projectFileWith, recordingDriver,
  type JsonRecord, type ParsePlan, type Recording,
} from './run-value-examples.ts';
import { fakeSecretValue } from './secret-examples.ts';

export { NEW_VERSION, ORIGIN, TARGET_ID, type JsonRecord };

// ---- The declared service and its secrets -------------------------------------------------------

// The shop's test API, on loopback, so the project declares it private.
export const SHOP_SERVICE = 'shop';
export const SHOP_ORIGIN = 'http://127.0.0.1:4180';
export const SHOP: JsonRecord = { name: SHOP_SERVICE, origin: SHOP_ORIGIN, private: true };

// A long-lived test token, sent as a bearer token.
export const TOKEN_SECRET = 'SHOP_API_TOKEN';
// An administrator's "user:password", sent with the basic scheme.
export const ADMIN_LOGIN_SECRET = 'SHOP_ADMIN_LOGIN';
// A password a plan passes to a secret parameter by name.
export const ADMIN_PASSWORD_SECRET = 'SHOP_ADMIN_PASSWORD';
export const SECRET_NAMES = [TOKEN_SECRET, ADMIN_LOGIN_SECRET, ADMIN_PASSWORD_SECRET];

// The value of the one literal header. No result or log may hold a header value.
export const HEADER_MARKER = 'suite-header-q7zx';

// Fresh fake secret values for this test process. No test reads the real environment.
export const SECRET_VALUES: Readonly<Record<string, string>> = {
  [TOKEN_SECRET]: fakeSecretValue(),
  [ADMIN_LOGIN_SECRET]: `admin:${fakeSecretValue()}`,
  [ADMIN_PASSWORD_SECRET]: fakeSecretValue(),
};

const bearer = { secretName: TOKEN_SECRET, scheme: 'bearer' };

// The order id the fake shop gives a new order: an identifier, so getOrder and deleteOrder take it.
export const ORDER_ID = 'ord_1042';

// The call declarations, as a person writes them in project.json.
export const CALLS: JsonRecord = {
  // Creates an order. Every safe parameter type appears, as a whole JSON value or inside a string.
  createOrder: {
    service: SHOP_SERVICE, method: 'POST', path: '/api/orders',
    headers: { authorization: bearer, 'x-test-suite': { literal: HEADER_MARKER } },
    body: {
      customer: { name: { $parameter: 'customerName' }, email: { $parameter: 'contactEmail' } },
      quantity: { $parameter: 'quantity' },
      region: { $parameter: 'region' },
      giftWrap: { $parameter: 'giftWrap' },
      deliveryDay: { $parameter: 'deliveryDay' },
      reference: { $interpolate: 'test-{region}-{quantity}', parameters: ['region', 'quantity'] },
    },
    parameters: {
      customerName: { kind: 'text', maximumLength: 40 },
      contactEmail: { kind: 'email' },
      quantity: { kind: 'integer', minimum: 1, maximum: 99 },
      region: { kind: 'oneOf', values: ['eu', 'us'] },
      giftWrap: { kind: 'boolean' },
      deliveryDay: { kind: 'yearMonthDay' },
    },
    effect: 'write', successStatuses: [201], fields: { orderId: '/id', status: '/status' }, allowInProposals: true,
  },
  // Reads an order back: the backend state a page may not show.
  getOrder: {
    service: SHOP_SERVICE, method: 'GET', path: '/api/orders/{orderId}',
    headers: { authorization: bearer },
    parameters: { orderId: { kind: 'identifier' } },
    effect: 'read', successStatuses: [200], fields: { status: '/status', total: '/total', echoedToken: '/echo/token' },
  },
  // Removes an order, for cleanup. A missing order counts as removed.
  deleteOrder: {
    service: SHOP_SERVICE, method: 'DELETE', path: '/api/orders/{orderId}',
    headers: { authorization: bearer },
    parameters: { orderId: { kind: 'identifier' } },
    effect: 'write', successStatuses: [204, 404], allowInProposals: true,
  },
  // Resets the shop's test data, signed in with the basic scheme.
  resetShop: {
    service: SHOP_SERVICE, method: 'POST', path: '/api/test/reset',
    headers: { authorization: { secretName: ADMIN_LOGIN_SECRET, scheme: 'basic' } },
    parameters: {},
    effect: 'write', successStatuses: [204], allowInProposals: true,
  },
  // Opens an administrator session with a password the plan names by secret.
  signInAsAdmin: {
    service: SHOP_SERVICE, method: 'POST', path: '/api/test/sessions',
    body: { password: { $parameter: 'adminPassword' } },
    parameters: { adminPassword: { kind: 'secret' } },
    effect: 'write', successStatuses: [201], fields: { sessionId: '/session' }, allowInProposals: true,
  },
  // Adds a note to a customer: text arguments in a path segment, query values and the body, and
  // an SQL-like string built only from types that cannot hold quotes, spaces or separators.
  addCustomerNote: {
    service: SHOP_SERVICE, method: 'POST', path: '/api/customers/{customerId}/notes',
    query: { tag: { $parameter: 'tag' }, page: { $parameter: 'page' } },
    headers: { authorization: bearer, 'x-test-suite': { literal: HEADER_MARKER } },
    body: {
      note: { $parameter: 'note' },
      author: { name: { $parameter: 'author' } },
      tags: [{ $parameter: 'tag' }, 'fixed'],
      vip: { $parameter: 'vip' },
      statement: {
        $interpolate: "select * from notes where page = {page} and region = '{region}'", parameters: ['page', 'region'],
      },
    },
    parameters: {
      customerId: { kind: 'text', maximumLength: 200 },
      note: { kind: 'text', maximumLength: 200 },
      author: { kind: 'text', maximumLength: 200 },
      tag: { kind: 'text', maximumLength: 200 },
      page: { kind: 'integer', minimum: 1, maximum: 1000 },
      region: { kind: 'oneOf', values: ['eu', 'us', 'apac'] },
      vip: { kind: 'boolean' },
    },
    effect: 'write', successStatuses: [200, 201], allowInProposals: true,
    timeoutMilliseconds: 2500, maximumResponseBytes: 4096,
  },
};

// The shared test project with the shop service, its secrets and the calls. `calls` adds or
// replaces declarations; `fields` adds or replaces other top-level fields.
export const callProjectFile = (
  calls: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {},
): JsonRecord => projectFileWith({ services: [SHOP], secretNames: SECRET_NAMES, calls: { ...CALLS, ...calls }, ...fields }, limits);

export function callProject(calls: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): Project {
  const parsed = parseProject(callProjectFile(calls, limits, fields));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const callParser = (calls: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}): ParsePlan =>
  planParser(callProject(calls, limits));

// The errors of a refused project file as "code path" lines, in the parser's order.
export function projectRefusal(projectFile: unknown): string[] {
  const parsed = parseProject(projectFile);
  assert.equal(parsed.ok, false, 'the project was accepted');
  return parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`);
}

// ---- Plan parts ---------------------------------------------------------------------------------

export const call = (name: unknown, callArguments: unknown = {}, remember?: unknown): JsonRecord =>
  ({ type: 'call', call: name, arguments: callArguments, ...(remember === undefined ? {} : { remember }) });

export const expectBackend = (name: unknown, callArguments: unknown, field: unknown, assertion: unknown): JsonRecord =>
  ({ type: 'expectBackend', call: name, arguments: callArguments, field, assert: assertion, criterionId: 'orders.backend-state' });

// A complete set of arguments for createOrder, with `changes` applied.
export const orderArguments = (changes: JsonRecord = {}): JsonRecord => ({
  customerName: 'Ada Lovelace', contactEmail: 'ada@example.com', quantity: 2, region: 'eu', giftWrap: false,
  deliveryDay: '2026-11-02', ...changes,
});

export const CREATE_ORDER: JsonRecord = call('createOrder', orderArguments(), { orderId: 'orderId' });
export const DELETE_ORDER: JsonRecord = call('deleteOrder', { orderId: { valueName: 'orderId' } });
export const RESET_SHOP: JsonRecord = call('resetShop');

export const withCleanup = (plan: JsonRecord, cleanup: readonly unknown[]): JsonRecord => ({ ...plan, cleanup });

// ---- Reading what the parser and the project give back ------------------------------------------

// The declaration a parsed project holds under `name`, and the service it names.
export function declarationOf(project: Pick<Project, 'calls'>, name: string) {
  const found = Object.entries(project.calls).find(([key]) => key === name);
  assert.ok(found !== undefined, `the project declares no call named ${name}`);
  return found[1];
}

export function serviceOf(project: Pick<Project, 'services'>, name: string) {
  const found = project.services.find((service) => service.name === name);
  assert.ok(found !== undefined, `the project declares no service named ${name}`);
  return found;
}

// A parsed plan's step as plain JSON, to compare with what the plan wrote.
export const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// ---- A fake service ------------------------------------------------------------------------------

export type Reply = Result<ServiceResponse, ServiceCallErrorCode>;
// Answers one request; `earlier` is every request the caller was handed before this one.
export type Route = (request: ServiceRequest, earlier: readonly ServiceRequest[]) => Reply;

export const jsonReply = (status: number, body: unknown): Reply =>
  success({ status, mediaType: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)) });
export const textReply = (status: number, mediaType: string | null, text: string): Reply =>
  success({ status, mediaType, body: new TextEncoder().encode(text) });
export const emptyReply = (status: number): Reply => success({ status, mediaType: null, body: new Uint8Array() });
export const failedReply = (code: ServiceCallErrorCode): Reply => failure(code);

// "METHOD /path?query", to route and to read what was sent.
export const requestLine = (request: ServiceRequest): string => `${request.method} ${request.pathAndQuery}`;

// The fake shop: an order is created, read back as paid, deleted; the test data is reset; an
// administrator session opens.
export const SHOP_ROUTE: Route = (request) => {
  const line = requestLine(request);
  if (line === 'POST /api/orders') return jsonReply(201, { id: ORDER_ID, status: 'pending' });
  if (line === `GET /api/orders/${ORDER_ID}`) return jsonReply(200, { status: 'paid', total: 42 });
  if (line === `DELETE /api/orders/${ORDER_ID}`) return emptyReply(204);
  if (line === 'POST /api/test/reset') return emptyReply(204);
  if (line === 'POST /api/test/sessions') return jsonReply(201, { session: 'session_7' });
  return jsonReply(404, { error: 'no such route' });
};

// The shop, with `override` answering first; undefined from it falls through to SHOP_ROUTE.
export const shopWith = (override: (request: ServiceRequest, earlier: readonly ServiceRequest[]) => Reply | undefined): Route =>
  (request, earlier) => override(request, earlier) ?? SHOP_ROUTE(request, earlier);

export type FakeServiceCaller = { readonly caller: ServiceCaller; readonly requests: ServiceRequest[] };

export function fakeServiceCaller(route: Route = SHOP_ROUTE): FakeServiceCaller {
  const requests: ServiceRequest[] = [];
  const caller: ServiceCaller = {
    async call(request) {
      const earlier = [...requests];
      requests.push(request);
      return route(request, earlier);
    },
  };
  return { caller, requests };
}

// ---- A virtual clock ----------------------------------------------------------------------------

export type VirtualClock = Clock & { readonly elapsed: () => number };

// Time moves only when the run sleeps, so a 10 s backend check takes no real time.
export function virtualClock(): VirtualClock {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => { time += Math.max(0, milliseconds); },
    elapsed: () => time,
  };
}

// ---- Running a plan with calls ------------------------------------------------------------------

export type CallRunOptions = {
  readonly route?: Route;
  readonly projectFile?: JsonRecord;
  // The secret store's environment; SECRET_VALUES unless the test says otherwise.
  readonly environment?: Readonly<Record<string, string>>;
  readonly standing?: PlanStanding;
  // False runs with no `services` port at all, as a run whose caller is not wired in.
  readonly withCaller?: boolean;
};

export type CallRun = {
  readonly result: RunResult;
  readonly recording: Recording;
  readonly requests: readonly ServiceRequest[];
  readonly events: readonly LoggedEvent[];
  readonly clock: VirtualClock;
  // The result and the run's event log, as JSON.
  readonly everything: string;
};

export async function runWithCalls(raw: unknown, options: CallRunOptions = {}): Promise<CallRun> {
  const projectFile = options.projectFile ?? callProjectFile();
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad test project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const plan = accepted(planParser(project), raw);
  const trusted = await trustedProjectFrom(projectFile);
  const { driver, recording } = recordingDriver();
  const { caller, requests } = fakeServiceCaller(options.route);
  const clock = virtualClock();
  const events = memoryRunEventSink();
  const result = await run({
    plan: authorise(plan, trusted, options.standing), project, targetId: project.matrix[0]?.id ?? assert.fail('no target'),
    baseUrl: ORIGIN, seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START, fixtures: [], host: { platform: 'test', arch: 'test' },
    ...(options.standing === undefined ? {} : { standing: options.standing }),
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events,
    secrets: environmentSecretStore(options.environment ?? SECRET_VALUES), ...(options.withCaller === false ? {} : { services: caller }),
  });
  const logged = events.read();
  return { result, recording, requests, events: logged, clock, everything: `${JSON.stringify(result)}\n${JSON.stringify(logged)}` };
}

// A raw 1.2 plan: the given steps, then a check the recording driver always passes.
export const CLOSING_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'orders.status-shown',
};
export const callPlanOf = (steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: NEW_VERSION,
  meta: { featureId: 'ORDERS-2', specReference: 'specs/orders.md#backend', title: 'Orders reach the backend' },
  targets: [TARGET_ID],
  steps: [...steps, CLOSING_CHECK],
  ...fields,
});

// ---- Records the run keeps ----------------------------------------------------------------------

export type CleanupRecord = { readonly outcome: string; readonly code?: string };

// The run's cleanup records, in order. See the assumptions at the top of this file.
export function cleanupRecords(result: RunResult): readonly CleanupRecord[] {
  const fields: Readonly<Record<string, unknown>> = result;
  const records = fields['cleanup'];
  assert.ok(Array.isArray(records), `the result records no cleanup: ${JSON.stringify(result)}`);
  return records.map((record: unknown): CleanupRecord => {
    assert.ok(typeof record === 'object' && record !== null && 'outcome' in record, JSON.stringify(record));
    const code = 'code' in record && typeof record.code === 'string' ? { code: record.code } : {};
    return { outcome: String(record.outcome), ...code };
  });
}

// The codes of the review items the run raised.
export function reviewItemCodes(result: RunResult): readonly string[] {
  const fields: Readonly<Record<string, unknown>> = result;
  const items = fields['reviewItems'];
  if (items === undefined) return [];
  assert.ok(Array.isArray(items), JSON.stringify(items));
  return items.map((item: unknown) => (typeof item === 'object' && item !== null && 'code' in item ? String(item.code) : ''));
}

// The step results of a run as "type outcome code" lines, to compare in one assertion.
export const stepLines = (result: RunResult): string[] =>
  result.steps.map((step) => `${step.type} ${step.outcome}${step.code === undefined ? '' : ` ${step.code}`}`);
