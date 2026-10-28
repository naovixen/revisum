// The plan examples the plan-language tests share, read from disk so every test sees the same
// bytes:
//   - golden/plans/*.json: plans in versions "1.1" and "1.2", in which every assertion carries
//     the id of the acceptance criterion it checks;
//   - fixtures/plan-migration/<name>.plan.json: the same plans as first written in version 1,
//     before assertions carried criterion ids, with <name>.mapping.json giving each assertion's
//     criterion id, keyed by the assertion step's JSON path.
// Each loader returns a fresh copy, so a test may change it freely.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject, planParser, type Project } from '@revisum/engine';
import { FIXTURES, GOLDEN } from '../../support/repository.ts';

export const ORIGIN = 'http://127.0.0.1:4173';
export const TARGET_ID = 'playwright-chromium';
// The version the SPEC-01 examples are written in; version 1.2 still parses them unchanged.
export const CURRENT_VERSION = '1.1';

// A JSON object as read from disk, before any parsing.
export type JsonRecord = Record<string, unknown>;

const PLAN_FOLDER = join(GOLDEN, 'plans');
const MIGRATION_FOLDER = join(FIXTURES, 'plan-migration');

const readJson = (path: string): JsonRecord => JSON.parse(readFileSync(path, 'utf8'));

export const goldenPlanNames = (): readonly string[] =>
  readdirSync(PLAN_FOLDER).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

export const migrationExampleNames = (): readonly string[] =>
  readdirSync(MIGRATION_FOLDER).filter((name) => name.endsWith('.plan.json')).map((name) => name.slice(0, -'.plan.json'.length)).sort();

export const goldenPlan = (name: string): JsonRecord => readJson(join(PLAN_FOLDER, `${name}.json`));
export const legacyPlan = (name: string): JsonRecord => readJson(join(MIGRATION_FOLDER, `${name}.plan.json`));
export const criterionMapping = (name: string): Readonly<Record<string, string>> =>
  readJson(join(MIGRATION_FOLDER, `${name}.mapping.json`)) as Record<string, string>;

// The sign-up plan in the current language. Its steps, by index:
//   0 navigate, 1 expect (visible), 2 expectPage (title), 3 fill, 4 fill, 5 expect (valueEquals),
//   6 capture, 7 click, 8 click, 9 expect (textContains), 10 expect (textContains), 11 a11yAudit, 12 capture.
export const signupPlan = (): JsonRecord => goldenPlan('signup');

// A plan that uses the steps the current language added. Its steps, by index:
//   0 navigate, 1 hover, 2 select, 3 frame (0 fill, 1 expect), 4 click, 5 dialog, 6 expect (absent), 7 expectPage.
export const accountClosurePlan = (): JsonRecord => goldenPlan('account-closure');

// The shop's test API, which the shared project declares as a service, with the secrets its calls
// use and the calls a plan may make (docs/specs/SPEC-32-declared-service-calls.md). The shapes are
// those of service-call-examples.ts, which adds authorization headers on top. The calls here name
// no secret themselves (signInAsAdmin's password is a secret parameter), so a test that replaces
// the secret names still gets a project that parses.
export const TEST_SERVICE: JsonRecord = { name: 'shop', origin: 'http://127.0.0.1:4180', private: true };
export const TEST_SERVICE_SECRET_NAMES = ['SHOP_API_TOKEN', 'SHOP_ADMIN_LOGIN', 'SHOP_ADMIN_PASSWORD'];
export const TEST_SERVICE_CALLS: JsonRecord = {
  createOrder: {
    service: 'shop', method: 'POST', path: '/api/orders',
    body: {
      customer: { name: { $parameter: 'customerName' }, email: { $parameter: 'contactEmail' } },
      quantity: { $parameter: 'quantity' }, region: { $parameter: 'region' }, giftWrap: { $parameter: 'giftWrap' },
      deliveryDay: { $parameter: 'deliveryDay' },
      reference: { $interpolate: 'test-{region}-{quantity}', parameters: ['region', 'quantity'] },
    },
    parameters: {
      customerName: { kind: 'text', maximumLength: 40 }, contactEmail: { kind: 'email' },
      quantity: { kind: 'integer', minimum: 1, maximum: 99 }, region: { kind: 'oneOf', values: ['eu', 'us'] },
      giftWrap: { kind: 'boolean' }, deliveryDay: { kind: 'yearMonthDay' },
    },
    effect: 'write', successStatuses: [201], fields: { orderId: '/id', status: '/status' }, allowInProposals: true,
  },
  getOrder: {
    service: 'shop', method: 'GET', path: '/api/orders/{orderId}', parameters: { orderId: { kind: 'identifier' } },
    effect: 'read', successStatuses: [200], fields: { status: '/status', total: '/total' },
  },
  deleteOrder: {
    service: 'shop', method: 'DELETE', path: '/api/orders/{orderId}', parameters: { orderId: { kind: 'identifier' } },
    effect: 'write', successStatuses: [204, 404], allowInProposals: true,
  },
  resetShop: {
    service: 'shop', method: 'POST', path: '/api/test/reset', parameters: {}, effect: 'write', successStatuses: [204], allowInProposals: true,
  },
  signInAsAdmin: {
    service: 'shop', method: 'POST', path: '/api/test/sessions', body: { password: { $parameter: 'adminPassword' } },
    parameters: { adminPassword: { kind: 'secret' } }, effect: 'write', successStatuses: [201], fields: { sessionId: '/session' },
    allowInProposals: true,
  },
};

// A trusted project with one target and the shop's test service, whose limits a test may tighten
// and to which a test may add or replace other project fields, such as declared secret names and
// fixtures.
export const testProjectInput = (limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): JsonRecord => ({
  origins: [ORIGIN],
  limits: { stepTimeoutMilliseconds: 2000, ...limits },
  matrix: [{
    id: TARGET_ID, adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
    locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce',
  }],
  services: [TEST_SERVICE],
  secretNames: TEST_SERVICE_SECRET_NAMES,
  calls: TEST_SERVICE_CALLS,
  ...fields,
});

export function testProject(limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): Project {
  const parsed = parseProject(testProjectInput(limits, fields));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const defaultParser = () => planParser(testProject());

// A deep copy of `input` with the value at `path` replaced, or removed when `value` is REMOVE.
// Each segment is an object key or an array index.
export const REMOVE: unique symbol = Symbol('remove');
export function withValue(input: unknown, path: readonly (string | number)[], value: unknown): JsonRecord {
  const copy: JsonRecord = structuredClone(input) as JsonRecord;
  let holder: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    holder = (holder as Record<string | number, unknown>)[segment];
    if (typeof holder !== 'object' || holder === null) throw new Error(`no object at ${String(segment)} in ${path.join('.')}`);
  }
  const last = path.at(-1);
  if (last === undefined) throw new Error('an empty path names no value');
  const target = holder as Record<string | number, unknown>;
  if (value === REMOVE) delete target[last];
  else target[last] = value;
  return copy;
}

// The steps of a raw plan, for tests that rebuild the step list.
export const stepsOf = (plan: JsonRecord): JsonRecord[] => plan['steps'] as JsonRecord[];

// A text no error message may contain: it stands for the private or hostile value in a plan.
export const PRIVATE_MARKER = 'private-marker-q7zx';
