// Shared setup for the browser tests of plan language 1.2's declared network stubs, request checks
// and web storage: the driver parts of each, carried out by the own CDP driver over CDP's Fetch,
// Network and DOMStorage domains, and refused by the Playwright fallback.
//
// It serves the network-stubs fixture app (fixtures/network-stubs-app/) twice, on two loopback
// ports, so storage can be written on one origin while the page is on the other. Beside the app's
// files it answers routes the tests build: JSON, text and slow answers under /api/, the server's
// own script, style sheet, frame, worker, image and page under /api/assets/, and the account page
// with a name made fresh for the harness. Every /api/ answer the server gives says
// "source": "server", so a page can tell it from a stub's answer.
//
// The trusted project declares the stubs, observed requests and storage entries below, on the
// first origin unless a name says otherwise, with a quiet window of QUIET_MILLISECONDS. Every
// declaration that writes may be used in a proposal, since the harness runs proposals.
// Plans are written as raw JSON, parsed against the project, cleared through the policy gate and
// run with run(). Every run reads the page just before the run closes its session, after an
// optional test hook.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type BrowserDriver, type Locator, type Plan, type Project, type RunEventSink, type RunResult, type SecretStore, type Session,
  type SessionEnvironment, type StepResult, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { startFixtureServer, type FixtureResponse, type FixtureRoute, type FixtureServer } from '../support/fixture-server.ts';
import {
  memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore, type MemoryEventSink,
} from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import type { JsonRecord } from './plan-values-support.ts';

export { click, navigate, outcomes, reference, role, testId, textEquals, type JsonRecord } from './plan-values-support.ts';

export const SEED = 33;
// The run's own clock start: 30 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.2';
export const STEP_TIMEOUT_MILLISECONDS = 5000;
// Longer than the 300 ms between the two requests "Load two batches" sends, so a count that waits
// for quiet sees both.
export const QUIET_MILLISECONDS = 800;
// The cap the bigItems request keeps of a body; /api/big-items answers with more.
export const BIG_ITEMS_CAP_BYTES = 1024;

export const CDP_TARGET = 'cdp-chromium';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';

export const FIXTURE_FOLDER = join(FIXTURES, 'network-stubs-app');
// The stub fixture whose JSON text holds script markup.
export const MARKUP_FIXTURE = 'script-markup.json';

// Secrets the project declares, for a stub's and a storage entry's secret parameter.
export const STUB_SECRET = 'STUB_ACCOUNT_TOKEN';
export const STORAGE_SECRET = 'STORAGE_SESSION_TOKEN';

// The items /api/items answers with: twelve, so an array length is a two-digit number.
export const ITEM_NAMES = [
  'Kettle', 'Toaster', 'Blender', 'Teapot', 'Grill', 'Mixer', 'Juicer', 'Steamer', 'Fryer', 'Scales', 'Whisk', 'Ladle',
] as const;
export const NEXT_PAGE_FIRST_ITEM = 'Colander';

const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

const matcher = (origin: string, method: string, path: string, match: 'exact' | 'prefix' = 'exact'): JsonRecord => ({ origin, method, path, match });
const jsonResponse = (json: unknown, status = 200): JsonRecord => ({ status, mediaType: 'application/json', body: { json } });

// The project file as a person writes it. `extraOrigins` are allowed besides the two fixture origins.
export const networkProjectFile = (origin: string, otherOrigin: string, extraOrigins: readonly string[] = []) => ({
  origins: [origin, otherOrigin, ...extraOrigins],
  limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, requestQuietMilliseconds: QUIET_MILLISECONDS },
  secretNames: [STUB_SECRET, STORAGE_SECRET],
  fixtures: [MARKUP_FIXTURE],
  stubs: {
    // Three answers in order; the last one repeats.
    answerSequence: {
      request: matcher(origin, 'GET', '/api/sequence'), parameters: {},
      responses: [jsonResponse({ answer: 1 }), jsonResponse({ answer: 2 }), jsonResponse({ answer: 3 })], allowInProposals: true,
    },
    // Data whose text holds script markup, from the project's fixtures folder.
    markupNotes: {
      request: matcher(origin, 'GET', '/api/notes'), parameters: {},
      responses: [{ status: 200, mediaType: 'application/json', body: { fixture: MARKUP_FIXTURE } }], allowInProposals: true,
    },
    // Everything under /api/assets/: only its fetch and XHR requests may get this answer.
    assetRequests: {
      request: matcher(origin, 'GET', '/api/assets/', 'prefix'), parameters: {},
      responses: [jsonResponse({ source: 'stub' })], allowInProposals: true,
    },
    workerItems: {
      request: matcher(origin, 'GET', '/api/worker-items'), parameters: {},
      responses: [jsonResponse({ source: 'stub', items: [{ name: 'Stubbed kettle' }] })], allowInProposals: true,
    },
    stubbedData: {
      request: matcher(origin, 'GET', '/api/stubbed-data'), parameters: {},
      responses: [jsonResponse({ source: 'stub' })], allowInProposals: true,
    },
    // A token from a declared secret, which the page shows in a private element.
    accountToken: {
      request: matcher(origin, 'GET', '/api/token'), parameters: { token: { kind: 'secret' } },
      responses: [jsonResponse({ token: { $parameter: 'token' } })], allowInProposals: true,
    },
  },
  observedRequests: {
    items: {
      request: matcher(origin, 'GET', '/api/items'),
      fields: { firstName: '/items/0/name', itemList: '/items', total: '/total', nothing: '/nothing' }, maximumResponseBytes: 4096,
    },
    bigItems: { request: matcher(origin, 'GET', '/api/big-items'), fields: { firstName: '/items/0/name' }, maximumResponseBytes: BIG_ITEMS_CAP_BYTES },
    plainItems: { request: matcher(origin, 'GET', '/api/plain-items'), fields: { firstName: '/items/0/name' } },
    missingItems: { request: matcher(origin, 'GET', '/api/missing-items'), fields: { code: '/code' } },
    neverSent: { request: matcher(origin, 'GET', '/api/never'), fields: { firstName: '/items/0/name' } },
    scheduleLoads: { request: matcher(origin, 'GET', '/api/schedule'), fields: { day: '/day' } },
    sequence: { request: matcher(origin, 'GET', '/api/sequence') },
    workerItems: { request: matcher(origin, 'GET', '/api/worker-items'), fields: { source: '/source' } },
    profile: { request: matcher(origin, 'GET', '/api/profile'), fields: { email: '/email' } },
    token: { request: matcher(origin, 'GET', '/api/token'), fields: { token: '/token' } },
  },
  storageEntries: {
    // A boolean parameter, so it is stored as the JSON text "true" or "false".
    menuDocked: {
      area: 'local', origin, key: 'navigation.docked', access: 'readWrite',
      value: { $parameter: 'docked' }, parameters: { docked: { kind: 'boolean' } }, allowInProposals: true,
    },
    // A string, stored as it is.
    visitGreeting: { area: 'session', origin, key: 'visit.greeting', access: 'readWrite', value: 'Welcome back', allowInProposals: true },
    // The same key on the other origin.
    otherMenuDocked: {
      area: 'local', origin: otherOrigin, key: 'navigation.docked', access: 'readWrite',
      value: { $parameter: 'docked' }, parameters: { docked: { kind: 'boolean' } }, allowInProposals: true,
    },
    // The name the account page keeps itself; a plan may only check it.
    profileName: { area: 'local', origin, key: 'profile.name', access: 'read', allowInProposals: false },
    sessionToken: {
      area: 'session', origin, key: 'auth.token', access: 'readWrite',
      value: { $parameter: 'token' }, parameters: { token: { kind: 'secret' } }, allowInProposals: true,
    },
  },
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
});

export const networkDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome, fixturesFolder: FIXTURE_FOLDER })],
  ['playwright', playwrightDriver()],
]);

// ---- Plans, written as raw JSON -------------------------------------------------------------

export const startStub = (name: string, stubArguments?: JsonRecord): JsonRecord =>
  ({ type: 'stub', stub: name, action: 'start', ...(stubArguments === undefined ? {} : { arguments: stubArguments }) });
export const stopStub = (name: string): JsonRecord => ({ type: 'stub', stub: name, action: 'stop' });
export const resetRequests = (name: string): JsonRecord => ({ type: 'resetRequests', request: name });
export const expectRequests = (name: string, count: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expectRequests', request: name, count, criterionId });
export const expectResponse = (name: string, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expectResponse', request: name, assert: assertion, criterionId });
export const rememberResponse = (valueName: string, request: string, field: string, read: 'text' | 'arrayLength'): JsonRecord =>
  ({ type: 'remember', name: valueName, from: { response: request, field, read } });
export const setStorage = (entry: string, entryArguments?: JsonRecord): JsonRecord =>
  ({ type: 'setStorage', entry, ...(entryArguments === undefined ? {} : { arguments: entryArguments }) });
export const removeStorage = (entry: string): JsonRecord => ({ type: 'removeStorage', entry });
export const expectStorage = (entry: string, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expectStorage', entry, assert: assertion, criterionId });
export const visible = (locator: JsonRecord, criterionId: string): JsonRecord => ({ type: 'expect', locator, assert: { kind: 'visible' }, criterionId });
export const titleIs = (value: string, criterionId: string): JsonRecord => ({ type: 'expectPage', assert: { kind: 'title', value }, criterionId });
export const secretArgument = (secretName: string): JsonRecord => ({ secretName });

// A raw 1.2 plan for one target. `fields` adds top-level fields. A plan must assert something;
// every test plan here does.
export const networkPlan = (targetId: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: { featureId: 'STUBS-1', specReference: 'specs/network-stubs.md#driver', title: 'Stubs, request checks and storage in a browser' },
  targets: [targetId],
  steps,
  ...fields,
});

// ---- Reading what a run recorded -------------------------------------------------------------

// The stub names a step result lists as active while it ran, sorted; none when it lists none.
export function activeStubsOf(step: StepResult | undefined): readonly string[] {
  assert.ok(step !== undefined, 'the step has a result');
  const fields: Readonly<Record<string, unknown>> = { ...step };
  const listed = fields['activeStubs'];
  if (listed === undefined) return [];
  assert.ok(Array.isArray(listed), `activeStubs is a list: ${JSON.stringify(listed)}`);
  return listed.map((name: unknown) => {
    assert.equal(typeof name, 'string', `an active stub is named by text: ${JSON.stringify(listed)}`);
    return String(name);
  }).sort();
}

// One stubbed answer a result records: which stub answered a request, and with which of its
// responses. Read from the result as plain JSON, wherever the result keeps it.
export type StubbedAnswer = { readonly stub: string; readonly responseIndex: number };

// Every record of a stubbed answer in the result, in the order the result's JSON holds them: any
// object with a stub name (under "stub" or "stubbed") and a numeric "responseIndex".
export function stubbedAnswersIn(result: RunResult): readonly StubbedAnswer[] {
  const found: StubbedAnswer[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== 'object' || value === null) return;
    const fields: Readonly<Record<string, unknown>> = { ...value };
    const stub = typeof fields['stub'] === 'string' ? fields['stub'] : fields['stubbed'];
    const responseIndex = fields['responseIndex'];
    if (typeof stub === 'string' && typeof responseIndex === 'number') found.push({ stub, responseIndex });
    for (const nested of Object.values(fields)) visit(nested);
  };
  visit(JSON.parse(JSON.stringify(result)));
  return found;
}

// ---- Server routes ----------------------------------------------------------------------------

// Values made fresh for one harness: personal data the account page and /api/profile hold.
// Neither begins with a step type, a field or a header name, so a leak scan's prefix check can
// only match the value itself.
export type Canaries = { readonly profileName: string; readonly profileEmail: string };

const json = (body: unknown, status = 200): FixtureResponse =>
  ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fileAs = (name: string, mediaType: string): FixtureRoute => {
  const bytes = readFileSync(join(FIXTURE_FOLDER, name));
  return () => ({ headers: { 'content-type': mediaType }, body: bytes });
};

// The server's own files under /api/assets/, by the path a page asks for.
export const SERVER_ASSETS: Readonly<Record<string, readonly [string, string]>> = {
  '/api/assets/widget.js': ['asset-widget.js', 'text/javascript'],
  '/api/assets/theme.css': ['asset-theme.css', 'text/css'],
  '/api/assets/frame.html': ['asset-frame.html', 'text/html; charset=utf-8'],
  '/api/assets/frame-message.js': ['asset-frame-message.js', 'text/javascript'],
  '/api/assets/worker.js': ['asset-worker.js', 'text/javascript'],
  '/api/assets/pixel.svg': ['asset-pixel.svg', 'image/svg+xml'],
  '/api/assets/page.html': ['asset-page.html', 'text/html; charset=utf-8'],
};

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
  const routes = new Map<string, FixtureRoute>();
  const items = (names: readonly string[]) => ({ source: 'server', items: names.map((name) => ({ name })), total: names.length });
  routes.set('/api/schedule', () => json({ source: 'server', day: 'Friday' }));
  routes.set('/api/sequence', () => json({ source: 'server', answer: 'server' }));
  routes.set('/api/items', (request) => {
    if (request.query.get('page') === '2') return json(items([NEXT_PAGE_FIRST_ITEM, 'Sieve']));
    if (request.query.get('slow') !== '1') return json(items(ITEM_NAMES));
    // Answered in two halves 600 ms apart, so the request stays in flight.
    const body = Buffer.from(JSON.stringify(items(ITEM_NAMES)), 'utf8');
    const half = Math.floor(body.length / 2);
    return { headers: { 'content-type': 'application/json' }, chunks: [body.subarray(0, half), body.subarray(half)], chunkPauseMilliseconds: 600 };
  });
  routes.set('/api/items-archive', () => json(items([])));
  routes.set('/api/big-items', () => json(items(Array.from({ length: 200 }, (_, index) => `Archived kettle number ${index}`))));
  routes.set('/api/plain-items', () => ({ headers: { 'content-type': 'text/plain' }, body: 'Kettle, Toaster' }));
  routes.set('/api/missing-items', () => json({ source: 'server', code: 'not-found' }, 404));
  routes.set('/api/notes', () => json({ source: 'server', note: 'Plain notes from the server', items: [] }));
  // The stub fixture's own bytes served as an HTML page, where its script markup does run.
  routes.set('/notes-as-page.html', fileAs(MARKUP_FIXTURE, 'text/html; charset=utf-8'));
  for (const [path, [file, mediaType]] of Object.entries(SERVER_ASSETS)) routes.set(path, fileAs(file, mediaType));
  routes.set('/api/assets/data.json', () => json({ source: 'server' }));
  routes.set('/api/worker-items', () => json({ source: 'server', items: [{ name: 'Server kettle' }] }));
  routes.set('/api/stubbed-data', () => json({ source: 'server' }));
  routes.set('/api/real-data', () => json({ source: 'server' }));
  routes.set('/api/profile', () => json({ source: 'server', email: canaries.profileEmail }));
  routes.set('/api/token', () => json({ source: 'server', token: 'server-token' }));
  const accountTemplate = readFileSync(join(FIXTURE_FOLDER, 'account.html'), 'utf8');
  routes.set('/account.html', () => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: accountTemplate.replace('PROFILE_NAME', canaries.profileName) }));
  return routes;
}

// ---- Reading the page at close --------------------------------------------------------------

// What the page showed just before the run closed its session: its URL, and the text of each
// test id the run was asked to read (null when that test id matched no single element).
export type PageAtClose = { readonly url: string; readonly shown: Readonly<Record<string, string | null>> };

// Wraps a driver so the sessions it opens run `atClose` as their close() begins, before the
// inner session closes.
function hookedAtClose(inner: BrowserDriver, atClose: (session: Session) => Promise<void>): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const close = async (): Promise<void> => {
          try { await atClose(session); } finally { await session.close(); }
        };
        const wrapped = new Proxy(session, {
          get(sessionTarget, sessionKey) {
            if (sessionKey === 'close') return close;
            const value: unknown = Reflect.get(sessionTarget, sessionKey, sessionTarget);
            return typeof value === 'function' ? value.bind(sessionTarget) : value;
          },
        });
        return { ok: true as const, value: wrapped };
      };
    },
  });
}

// ---- The harness ----------------------------------------------------------------------------

export type NetworkRun = {
  readonly result: RunResult;
  readonly events: RunEventSink;
  readonly audit: MemoryEventSink;
  readonly store: MemoryArtifactStore;
  // Null when no session opened, or it was never closed.
  readonly atClose: PageAtClose | null;
  // The paths each fixture server was asked for during the run, in order, without their queries.
  readonly requestedPaths: readonly string[];
  readonly otherRequestedPaths: readonly string[];
};

export type NetworkRunOptions = {
  // Test ids whose text to read at close; the input-event counter by default.
  readonly read?: readonly string[];
  // Drivers by adapter id, in place of the harness's own.
  readonly drivers?: ReadonlyMap<string, BrowserDriver>;
  // Where the plan's secrets are resolved.
  readonly secrets?: SecretStore;
  // Runs as the session's close() begins, before the page is read.
  readonly beforeClose?: (session: Session) => Promise<void>;
};

export type NetworkHarnessOptions = {
  // Origins the project allows besides the two fixture origins, such as one only a proxy blocks.
  readonly extraOrigins?: readonly string[];
};

export type NetworkHarness = {
  readonly server: FixtureServer;
  readonly otherServer: FixtureServer;
  readonly origin: string;
  readonly otherOrigin: string;
  readonly project: Project;
  // The harness's own drivers by adapter id, made once.
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  readonly canaries: Canaries;
  plan(raw: unknown): Plan;
  // One locator, parsed by the real parser so a direct probe gets branded values.
  locator(raw: JsonRecord): Locator;
  target(targetId: string): Target;
  run(plan: Plan, targetId: string, options?: NetworkRunOptions): Promise<NetworkRun>;
  // networkPlan, parsed and run on the target.
  runSteps(targetId: string, steps: readonly unknown[], options?: NetworkRunOptions & { readonly fields?: JsonRecord }): Promise<NetworkRun>;
  // The text a probe of the test id shows on the session's current page, or null when it matches no single element.
  shownOn(session: Session, id: string): Promise<string | null>;
  url(path: string): string;
  otherUrl(path: string): string;
  close(): Promise<void>;
};

export async function networkHarness(options: NetworkHarnessOptions = {}): Promise<NetworkHarness> {
  const nonce = randomBytes(5).toString('hex');
  const canaries: Canaries = { profileName: `Zqvoth${nonce} Ellery`, profileEmail: `zqmail${nonce}.holder@example.test` };
  const routes = routesFor(canaries);
  const requested: string[] = [];
  const otherRequested: string[] = [];
  const server = await startFixtureServer(FIXTURE_FOLDER, (path) => { requested.push(path); }, routes);
  const otherServer = await startFixtureServer(FIXTURE_FOLDER, (path) => { otherRequested.push(path); }, routes);
  const projectFile = networkProjectFile(server.origin, otherServer.origin, options.extraOrigins);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad network-stubs project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const locator = (raw: JsonRecord): Locator => {
    const parsed = plan(networkPlan(CDP_TARGET, [{ type: 'navigate', url: '/' }, visible(raw, 'probe.located')]));
    const step = parsed.steps[1];
    assert.ok(step !== undefined && step.type === 'expect');
    return step.locator;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const drivers = networkDrivers();

  const shownOn = async (session: Session, id: string): Promise<string | null> => {
    const probed = await session.probe(locator({ by: 'testId', testId: id }));
    return probed.count === 1 ? probed.text : null;
  };
  const readPage = async (session: Session, testIds: readonly string[]): Promise<PageAtClose> => {
    const shown: Record<string, string | null> = {};
    for (const id of testIds) shown[id] = await shownOn(session, id);
    return { url: (await session.page()).url, shown };
  };

  const runPlan = async (parsedPlan: Plan, targetId: string, runOptions: NetworkRunOptions = {}): Promise<NetworkRun> => {
    const chosen = runOptions.drivers ?? drivers;
    const pages: PageAtClose[] = [];
    const testIds = runOptions.read ?? ['input-events'];
    const atClose = async (session: Session): Promise<void> => {
      // The page is read first, then the hook may move it elsewhere.
      pages.push(await readPage(session, testIds));
      if (runOptions.beforeClose !== undefined) await runOptions.beforeClose(session);
    };
    const hooked = new Map([...chosen].map(([adapter, driver]) => [adapter, hookedAtClose(driver, atClose)] as const));
    const events = memoryRunEventSink();
    const audit = memoryEventSink();
    const store = memoryArtifactStore();
    const firstRequest = requested.length;
    const firstOtherRequest = otherRequested.length;
    // The target id comes from the trusted test project, so it is used as the branded value directly.
    const result = await run({
      project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
      fixtures: server.fixtures, host: { platform: platform(), arch: arch() }, plan: authorise(parsedPlan, trusted), targetId: targetId as TargetId,
    }, {
      drivers: hooked, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit, events,
      ...(runOptions.secrets === undefined ? {} : { secrets: runOptions.secrets }),
    });
    return {
      result, events, audit, store, atClose: pages[0] ?? null,
      requestedPaths: requested.slice(firstRequest), otherRequestedPaths: otherRequested.slice(firstOtherRequest),
    };
  };

  return {
    server, otherServer, origin: server.origin, otherOrigin: otherServer.origin, project, drivers, canaries, plan, locator, target,
    run: runPlan,
    runSteps: (targetId, steps, runOptions = {}) => runPlan(plan(networkPlan(targetId, steps, runOptions.fields ?? {})), targetId, runOptions),
    shownOn,
    url: (path) => `${server.origin}${path}`,
    otherUrl: (path) => `${otherServer.origin}${path}`,
    close: async () => { await server.close(); await otherServer.close(); },
  };
}

// How many times the paths list holds `path`.
export const timesRequested = (paths: readonly string[], path: string): number => paths.filter((requestedPath) => requestedPath === path).length;
