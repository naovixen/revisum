// Shared setup for the browser tests of plan language 1.3's page parts: CSS and XPath locators, DOM
// checks and page scripts, carried out by the own CDP driver and by the Playwright fallback.
//
// It serves the unsafe-features fixture app (fixtures/unsafe-features-app/). Beside the app's files
// it answers two routes: /orders.html, whose order row carries a canary order id made fresh for the
// harness, and /leaks.html, served with a session cookie, readable by scripts, holding a canary.
//
// The trusted project enables CSS locators, XPath locators, DOM checks, named page scripts and
// inline scripts, and lists one CSS selector, button.icon-close, that may resolve a control with no
// accessible name. Its named scripts are the files under the fixture project's plans/scripts/
// folder (fixtures/unsafe-features-project/), passed to the run as its script sources, keyed by
// each declared file path. Its targets are the own CDP driver on Chrome for Testing and the
// Playwright fallback on Chromium, in English (so the engine's English irreversible patterns apply
// to the runtime guard) and in London time. It declares one secret, typed into the leak page.
//
// Plans are written as raw JSON, parsed against the project, cleared through the policy gate (as a
// proposal unless a standing is given) and run with run(). Every run reads chosen test ids just
// before the run closes its session, such as the input-event counter every fixture page keeps
// (counting.js), so a test can show what a refused or denied step did not send.
//
// The capability model is settled in the spec's "Page parts" bullet: a driver declares
// structuralLocators, domChecks and pageScripts in AdapterInfo.performs, and both drivers declare
// all three. A script's source is one function expression, called once with one object of named
// JSON arguments.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type BrowserDriver, type Locator, type Plan, type PlanStanding, type Project, type RunEventSink, type RunResult, type SecretStore,
  type Session, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { startFixtureServer, type FixtureRoute, type FixtureServer } from '../support/fixture-server.ts';
import {
  memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore, type MemoryEventSink,
} from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import { sessionWith, wrappingSessions } from './clock-and-clipboard-support.ts';
import type { JsonRecord } from './plan-values-support.ts';

export {
  click, fill, label, navigate, outcomes, reference, role, testId, textEquals, valueEquals, type JsonRecord,
} from './plan-values-support.ts';
export { sessionWith, wrappingSessions } from './clock-and-clipboard-support.ts';

export const SEED = 36;
// The run's own clock start: 31 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 31, 12, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.3';
// Longer than any script timeout below, so a script timeout can be told from a step timeout.
export const STEP_TIMEOUT_MILLISECONDS = 5000;
// How long an expectScript check repeats before it fails.
export const SCRIPT_CHECK_TIMEOUT_MILLISECONDS = 1000;
// The most scripts one run may call. Every script call counts toward it.
export const MAXIMUM_CALLS = 200;

export const CDP_TARGET = 'cdp-chromium';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';
// This spec names both drivers, so every browser test runs on both.
export const BOTH_TARGETS = [CDP_TARGET, PLAYWRIGHT_TARGET] as const;
export const ADAPTER_OF: Readonly<Record<string, string>> = { [CDP_TARGET]: 'cdp', [PLAYWRIGHT_TARGET]: 'playwright' };

// The features this spec adds to the driver capability model.
export const PAGE_PART_FEATURES = ['structuralLocators', 'domChecks', 'pageScripts'] as const;
export type PagePartFeature = (typeof PAGE_PART_FEATURES)[number];

// The secret the leak page's token field is filled with.
export const PAGE_SECRET = 'PAGE_ACCESS_TOKEN';

// The one selector the project allows to resolve a control with no accessible name.
export const ALLOWED_UNNAMED_SELECTOR = 'button.icon-close';

export const FIXTURE_FOLDER = join(FIXTURES, 'unsafe-features-app');
export const PROJECT_FOLDER = join(FIXTURES, 'unsafe-features-project');

// ---- Declared page scripts ------------------------------------------------------------------------

export const ECHO_ARGUMENTS_FILE = 'plans/scripts/echo-arguments.js';
export const HOSTILE_RESULT_FILE = 'plans/scripts/hostile-result.js';
export const HOSTILE_EGRESS_FILE = 'plans/scripts/hostile-egress.js';
export const LEAKY_RESULT_FILE = 'plans/scripts/leaky-result.js';
export const COUNT_RUN_FILE = 'plans/scripts/count-run.js';
const SCRIPT_FILES = [ECHO_ARGUMENTS_FILE, HOSTILE_RESULT_FILE, HOSTILE_EGRESS_FILE, LEAKY_RESULT_FILE, COUNT_RUN_FILE] as const;

// A declared script file's bytes, as the protected branch would hold them.
export const scriptFileBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(join(PROJECT_FOLDER, file)));
export const scriptFileText = (file: string): string => new TextDecoder('utf-8', { fatal: true }).decode(scriptFileBytes(file));

// What echoArguments accepts: text of up to this many characters, a whole number and a boolean.
export const ECHO_TEXT_MAXIMUM_LENGTH = 200;
export const ECHO_COUNT_MAXIMUM = 1_000_000;

// The kinds of result hostileResult gives, by its `kind` argument. `sized` pads its result with
// `amount` characters; `nested` wraps a value in `amount` arrays.
export const HOSTILE_RESULT_KINDS = ['plain', 'sized', 'nested', 'cyclic', 'undefined', 'function', 'throws', 'rejects', 'never-settles'] as const;
export type HostileResultKind = (typeof HOSTILE_RESULT_KINDS)[number];
// hostileResult's own limits: a result over this many bytes is too large, and it times out after this long.
export const HOSTILE_RESULT_MAXIMUM_BYTES = 1024;
export const HOSTILE_RESULT_TIMEOUT_MILLISECONDS = 1000;

export const PAGE_SCRIPTS: JsonRecord = {
  echoArguments: {
    file: ECHO_ARGUMENTS_FILE,
    parameters: {
      text: { kind: 'text', maximumLength: ECHO_TEXT_MAXIMUM_LENGTH },
      count: { kind: 'integer', minimum: 0, maximum: ECHO_COUNT_MAXIMUM },
      flag: { kind: 'boolean' },
    },
    effect: 'read', fields: { report: '/report' }, allowInProposals: false,
  },
  hostileResult: {
    file: HOSTILE_RESULT_FILE,
    parameters: { kind: { kind: 'oneOf', values: [...HOSTILE_RESULT_KINDS] }, amount: { kind: 'integer', minimum: 0, maximum: 100_000 } },
    effect: 'read', fields: { shape: '/shape' }, allowInProposals: false,
    timeoutMilliseconds: HOSTILE_RESULT_TIMEOUT_MILLISECONDS, maximumResultBytes: HOSTILE_RESULT_MAXIMUM_BYTES,
  },
  hostileEgress: {
    file: HOSTILE_EGRESS_FILE, parameters: {}, effect: 'write', fields: { attempts: '/attempts' }, allowInProposals: true,
    timeoutMilliseconds: 10_000,
  },
  leakyResult: {
    file: LEAKY_RESULT_FILE, parameters: {}, effect: 'read', fields: { status: '/status', itemCount: '/itemCount' }, allowInProposals: false,
  },
  countRun: {
    file: COUNT_RUN_FILE, parameters: {}, effect: 'write', fields: { runs: '/runs' }, allowInProposals: true,
  },
};

const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

// The project file as a person writes it. `extraOrigins` widens the browser's allow-list, for the
// egress tests, where only the proxy outside the browser may stand in the way.
export const unsafePageProjectFile = (origin: string, extraOrigins: readonly string[] = []) => ({
  origins: [origin, ...extraOrigins],
  limits: {
    stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, scriptCheckTimeoutMilliseconds: SCRIPT_CHECK_TIMEOUT_MILLISECONDS,
    maximumCalls: MAXIMUM_CALLS, maximumSteps: 1000, maximumPlanBytes: 1024 * 1024, maximumTextLength: 4000,
  },
  secretNames: [PAGE_SECRET],
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
  unsafeFeatures: {
    cssLocators: true, xpathLocators: true, domChecks: true,
    pageScripts: { scripts: PAGE_SCRIPTS, allowInline: true },
    unnamedControlsAllowed: [ALLOWED_UNNAMED_SELECTOR],
  },
});

export const unsafePageDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome })],
  ['playwright', playwrightDriver()],
]);

// ---- Plans, written as raw JSON -------------------------------------------------------------

export const css = (selector: string, fields: JsonRecord = {}): JsonRecord => ({ by: 'css', selector, ...fields });
export const xpath = (expression: string, fields: JsonRecord = {}): JsonRecord => ({ by: 'xpath', expression, ...fields });

export const check = (locator: JsonRecord, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: assertion, criterionId });
export const rememberAttribute = (name: string, element: JsonRecord, attribute: string): JsonRecord =>
  ({ type: 'remember', name, from: { element, read: 'attribute', attribute } });
export const capture = (name: string): JsonRecord => ({ type: 'capture', name });
export const secretValue = (secretName: string): JsonRecord => ({ secretName });

export const evaluate = (script: unknown, scriptArguments: JsonRecord = {}, remember?: JsonRecord): JsonRecord =>
  ({ type: 'evaluate', script, arguments: scriptArguments, ...(remember === undefined ? {} : { remember }) });
export const expectScript = (script: unknown, scriptArguments: JsonRecord, field: string, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expectScript', script, arguments: scriptArguments, field, assert: assertion, criterionId });
export const inlineScript = (source: string, effect: 'read' | 'write', fields: JsonRecord): JsonRecord => ({ inline: { source, effect, fields } });
export const hostileResult = (kind: HostileResultKind, amount = 0): JsonRecord => evaluate('hostileResult', { kind, amount });

// The Continue button on the index page, and the check that it was pressed: a run that reaches
// them sends input and passes; a run stopped before them leaves the page untouched.
export const continueStep = (): JsonRecord => ({ type: 'click', locator: { by: 'role', role: 'button', name: 'Continue' } });
export const continued = (): JsonRecord => check({ by: 'testId', testId: 'continue-state' }, { kind: 'textEquals', value: 'Continued' }, 'page.continued');

// A raw 1.3 plan for one target. A plan must assert something; every test plan here does.
export const unsafePagePlan = (targetId: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: { featureId: 'UNSAFE-1', specReference: 'specs/unsafe-page-parts.md#driver', title: 'Unsafe page features in a browser' },
  targets: [targetId],
  steps,
  ...fields,
});

// ---- Reading what a run recorded -------------------------------------------------------------

// The real time the step at `index` took.
export function stepMilliseconds(result: RunResult, index: number): number {
  const taken = result.timings.stepMilliseconds[index];
  assert.ok(taken !== undefined, `step ${index} has a timing: ${JSON.stringify(result.timings)}`);
  return taken;
}

// ---- Server routes ----------------------------------------------------------------------------

// Values made fresh for one harness. Each begins with no step type, field or header name, so a leak
// scan's prefix check can only match the value itself.
export type Canaries = { readonly orderId: string; readonly sessionCookie: string };

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
  const routes = new Map<string, FixtureRoute>();
  const ordersTemplate = readFileSync(join(FIXTURE_FOLDER, 'orders.html'), 'utf8');
  routes.set('/orders.html', () => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: ordersTemplate.replace('ORDER_ID', canaries.orderId) }));
  const leaksPage = readFileSync(join(FIXTURE_FOLDER, 'leaks.html'), 'utf8');
  routes.set('/leaks.html', () => ({
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `session_id=${canaries.sessionCookie}; Path=/; SameSite=Lax` },
    body: leaksPage,
  }));
  return routes;
}

// ---- The harness ----------------------------------------------------------------------------

// What the page showed just before the run closed its session: the text of each test id the run
// was asked to read (null when that test id matched no single element).
export type PageAtClose = { readonly url: string; readonly shown: Readonly<Record<string, string | null>> };

export type UnsafePageRun = {
  readonly result: RunResult;
  readonly events: RunEventSink;
  readonly audit: MemoryEventSink;
  readonly store: MemoryArtifactStore;
  // Null when no session opened, or it was never closed.
  readonly atClose: PageAtClose | null;
  // The paths the fixture server was asked for during the run, in order.
  readonly requestedPaths: readonly string[];
};

export type UnsafePageRunOptions = {
  // Test ids whose text to read at close; the input-event counter by default.
  readonly read?: readonly string[];
  // Drivers by adapter id, in place of the harness's own.
  readonly drivers?: ReadonlyMap<string, BrowserDriver>;
  // Where the plan's secrets are resolved.
  readonly secrets?: SecretStore;
  // The plan's standing; absent, the run is a proposal.
  readonly standing?: PlanStanding;
  // The script sources the run is given, in place of the fixture project's files.
  readonly scriptSources?: Readonly<Record<string, Uint8Array>>;
};

export type UnsafePageHarness = {
  readonly server: FixtureServer;
  readonly origin: string;
  readonly project: Project;
  // The harness's own drivers by adapter id, made once.
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  readonly canaries: Canaries;
  // The fixture project's script files, keyed by declared file path.
  readonly scriptSources: Readonly<Record<string, Uint8Array>>;
  plan(raw: unknown): Plan;
  target(targetId: string): Target;
  run(plan: Plan, targetId: string, options?: UnsafePageRunOptions): Promise<UnsafePageRun>;
  // unsafePagePlan, parsed and run on the target.
  runSteps(targetId: string, steps: readonly unknown[], options?: UnsafePageRunOptions & { readonly fields?: JsonRecord }): Promise<UnsafePageRun>;
  url(path: string): string;
  close(): Promise<void>;
};

export type UnsafePageHarnessOptions = { readonly extraOrigins?: readonly string[] };

export async function unsafePageHarness(options: UnsafePageHarnessOptions = {}): Promise<UnsafePageHarness> {
  const nonce = randomBytes(5).toString('hex');
  const canaries: Canaries = { orderId: `Zqorder${nonce}ref${nonce}`, sessionCookie: `Zqsession${nonce}cookie` };
  const requested: string[] = [];
  const server = await startFixtureServer(FIXTURE_FOLDER, (path) => { requested.push(path); }, routesFor(canaries));
  const projectFile = unsafePageProjectFile(server.origin, options.extraOrigins ?? []);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad unsafe-page project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const locator = (raw: JsonRecord): Locator => {
    const parsed = plan(unsafePagePlan(CDP_TARGET, [{ type: 'navigate', url: '/' }, check(raw, { kind: 'visible' }, 'probe.located')]));
    const step = parsed.steps[1];
    assert.ok(step !== undefined && step.type === 'expect');
    return step.locator;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const drivers = unsafePageDrivers();
  const scriptSources = Object.fromEntries(SCRIPT_FILES.map((file) => [file, scriptFileBytes(file)]));

  const readPage = async (session: Session, testIds: readonly string[]): Promise<PageAtClose> => {
    const shown: Record<string, string | null> = {};
    for (const id of testIds) {
      const probed = await session.probe(locator({ by: 'testId', testId: id }));
      shown[id] = probed.count === 1 ? probed.text : null;
    }
    return { url: (await session.page()).url, shown };
  };

  const runPlan = async (parsedPlan: Plan, targetId: string, runOptions: UnsafePageRunOptions = {}): Promise<UnsafePageRun> => {
    const chosen = runOptions.drivers ?? drivers;
    const pages: PageAtClose[] = [];
    const testIds = runOptions.read ?? ['input-events'];
    // Each session reads the page as its close() begins, before the inner session closes.
    const reading = new Map([...chosen].map(([adapter, driver]) => [adapter, wrappingSessions(driver, (session) => sessionWith(session, {
      close: async (): Promise<void> => {
        try { pages.push(await readPage(session, testIds)); } finally { await session.close(); }
      },
    }))] as const));
    const events = memoryRunEventSink();
    const audit = memoryEventSink();
    const store = memoryArtifactStore();
    const firstRequest = requested.length;
    // The target id comes from the trusted test project, so it is used as the branded value directly.
    const result = await run({
      project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
      fixtures: server.fixtures, host: { platform: platform(), arch: arch() },
      plan: authorise(parsedPlan, trusted, runOptions.standing), targetId: targetId as TargetId,
      scriptSources: runOptions.scriptSources ?? scriptSources,
      ...(runOptions.standing === undefined ? {} : { standing: runOptions.standing }),
    }, {
      drivers: reading, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit, events,
      ...(runOptions.secrets === undefined ? {} : { secrets: runOptions.secrets }),
    });
    return { result, events, audit, store, atClose: pages[0] ?? null, requestedPaths: requested.slice(firstRequest) };
  };

  return {
    server, origin: server.origin, project, drivers, canaries, scriptSources, plan, target,
    run: runPlan,
    runSteps: (targetId, steps, runOptions = {}) => runPlan(plan(unsafePagePlan(targetId, steps, runOptions.fields ?? {})), targetId, runOptions),
    url: (path) => `${server.origin}${path}`,
    close: () => server.close(),
  };
}

// The features a driver lists, as plain names.
export const listedFeatures = (driver: BrowserDriver | undefined): readonly string[] => {
  assert.ok(driver !== undefined, 'the harness has the driver');
  return (driver.info.performs ?? []).map((feature) => String(feature));
};

// The harness's drivers with one adapter's list lacking one feature, and nothing else changed.
export function driversWithout(harness: UnsafePageHarness, adapter: string, feature: PagePartFeature): ReadonlyMap<string, BrowserDriver> {
  const inner = harness.drivers.get(adapter);
  assert.ok(inner !== undefined, `the harness has the ${adapter} driver`);
  const performs = (inner.info.performs ?? []).filter((listed) => String(listed) !== feature);
  const lacking = new Proxy(inner, {
    get: (target, key) => (key === 'info' ? { ...target.info, performs } : Reflect.get(target, key, target)),
  });
  return new Map([...harness.drivers, [adapter, lacking]]);
}
