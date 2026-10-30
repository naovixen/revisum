// Shared setup for the browser tests of plan language 1.2's driver parts: the plan clock,
// remembered values, positions, declared test-id attributes, key chords and multi-line fills.
//
// It serves the plan-values fixture app (fixtures/plan-values-app/), parses plans written as raw
// JSON against a trusted project, clears them through the policy gate and runs them with run().
// The project's targets are the own CDP driver on Chrome for Testing and on its headless shell,
// and the Playwright fallback on Chromium, all in English (so the engine's built-in English
// irreversible patterns apply to the runtime guard) and in London time. It declares three test-id
// attributes: data-testid, data-qa and id.
//
// Every run reads the page just before the run closes its session: the page's URL and the texts
// of chosen test ids, such as the input-event counter every fixture page keeps (counting.js), so
// a test can show what a failed or refused step did not send.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type BrowserDriver, type Locator, type Plan, type Project, type RunEventSink, type RunResult, type Session,
  type SessionEnvironment, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import {
  memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore, type MemoryEventSink,
} from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';

export const SEED = 23;
// The run's own clock start: 28 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 28, 12, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.2';
export const STEP_TIMEOUT_MILLISECONDS = 2000;

export const CDP_TARGET = 'cdp-chromium';
export const HEADLESS_SHELL_TARGET = 'cdp-chromium-headless-shell';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';
// Both targets of the own CDP driver: the same driver with a different executable.
export const CDP_TARGETS = [CDP_TARGET, HEADLESS_SHELL_TARGET] as const;

export const TEST_ID_ATTRIBUTES = ['data-testid', 'data-qa', 'id'] as const;

const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

// The project file as a person writes it.
export const planValuesProjectFile = (origin: string) => ({
  origins: [origin],
  limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
  testIdAttributes: [...TEST_ID_ATTRIBUTES],
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: HEADLESS_SHELL_TARGET, adapter: 'cdp-headless-shell', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
});

export const planValuesDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome })],
  ['cdp-headless-shell', cdpDriver({ executablePath: BROWSERS.chromeHeadlessShell })],
  ['playwright', playwrightDriver()],
]);

// ---- Plans, written as raw JSON -------------------------------------------------------------

export type JsonRecord = Readonly<Record<string, unknown>>;

export const role = (roleName: string, name: unknown, extra: JsonRecord = {}): JsonRecord => ({ by: 'role', role: roleName, name, ...extra });
export const label = (text: unknown, extra: JsonRecord = {}): JsonRecord => ({ by: 'label', label: text, ...extra });
export const text = (shown: unknown, extra: JsonRecord = {}): JsonRecord => ({ by: 'text', text: shown, ...extra });
export const testId = (id: unknown, extra: JsonRecord = {}): JsonRecord => ({ by: 'testId', testId: id, ...extra });
export const reference = (valueName: string): JsonRecord => ({ valueName });

export const navigate = (url: unknown): JsonRecord => ({ type: 'navigate', url });
export const click = (locator: JsonRecord): JsonRecord => ({ type: 'click', locator });
export const fill = (locator: JsonRecord, value: unknown): JsonRecord => ({ type: 'fill', locator, value });
export const press = (locator: JsonRecord, key: string, modifiers?: readonly string[]): JsonRecord =>
  (modifiers === undefined ? { type: 'press', locator, key } : { type: 'press', locator, key, modifiers });
export const remember = (name: string, element: JsonRecord, read: 'text' | 'value' = 'text'): JsonRecord =>
  ({ type: 'remember', name, from: { element, read } });
export const textEquals = (locator: JsonRecord, value: unknown, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: { kind: 'textEquals', value }, criterionId });
export const valueEquals = (locator: JsonRecord, value: unknown, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: { kind: 'valueEquals', value }, criterionId });
export const pathStartsWith = (value: string, criterionId: string): JsonRecord =>
  ({ type: 'expectPage', assert: { kind: 'urlPathStartsWith', value }, criterionId });

// A raw 1.2 plan for one target. `fields` adds top-level fields, such as `values` or `clock`.
// A plan must assert something; every test plan here does.
export const planFor = (targetId: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: { featureId: 'VALUES-1', specReference: 'specs/plan-values.md#driver', title: 'Plan values in a browser' },
  targets: [targetId],
  steps,
  ...fields,
});

// One step's outcome as [index, outcome, code], the shape the tests compare.
export const outcomes = (result: RunResult): readonly (readonly [number, string, string | undefined])[] =>
  result.steps.map((step) => [step.index, step.outcome, step.code] as const);

// ---- Reading the page at close --------------------------------------------------------------

// What the page showed just before the run closed its session: its URL, and the text of each
// test id the run was asked to read (null when that test id matched no single element).
export type PageAtClose = { readonly url: string; readonly shown: Readonly<Record<string, string | null>> };

// Wraps a driver so the sessions it opens read the page as their close() begins.
function readingAtClose(inner: BrowserDriver, read: (session: Session) => Promise<PageAtClose>, keep: (page: PageAtClose) => void): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const close = async (): Promise<void> => {
          try { keep(await read(session)); } finally { await session.close(); }
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

// A driver that opens one real session on its first open() and hands that same session to every
// later run, so many replays share one browser. Each run's close() leaves it open; closeAll()
// ends it. Every environment a run asked for is kept, so a test can show they were all the same.
export type ReusedSessionDriver = {
  readonly driver: BrowserDriver;
  readonly environments: readonly SessionEnvironment[];
  closeAll(): Promise<void>;
};

export function reusedSessionDriver(inner: BrowserDriver): ReusedSessionDriver {
  const environments: SessionEnvironment[] = [];
  const shared: { session: Session | null } = { session: null };
  const driver = new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        environments.push(environment);
        if (shared.session === null) {
          const opened = await target.open(openTarget, environment);
          if (!opened.ok) return opened;
          shared.session = opened.value;
        }
        const wrapped = new Proxy(shared.session, {
          get(sessionTarget, sessionKey) {
            if (sessionKey === 'close') return async (): Promise<void> => undefined;
            const value: unknown = Reflect.get(sessionTarget, sessionKey, sessionTarget);
            return typeof value === 'function' ? value.bind(sessionTarget) : value;
          },
        });
        return { ok: true as const, value: wrapped };
      };
    },
  });
  return {
    driver, environments,
    async closeAll() {
      const session = shared.session;
      shared.session = null;
      if (session !== null) await session.close();
    },
  };
}

// ---- The harness ----------------------------------------------------------------------------

export type PlanRun = {
  readonly result: RunResult;
  readonly events: RunEventSink;
  readonly audit: MemoryEventSink;
  readonly store: MemoryArtifactStore;
  // Null when no session opened, or it was never closed.
  readonly atClose: PageAtClose | null;
  // The paths the fixture server was asked for during the run, in order.
  readonly requestedPaths: readonly string[];
};

export type RunOptions = {
  // Test ids whose text to read at close; the input-event counter by default.
  readonly read?: readonly string[];
  // Drivers by adapter id, in place of the harness's own.
  readonly drivers?: ReadonlyMap<string, BrowserDriver>;
  readonly clockStartMilliseconds?: number;
};

export type PlanValuesHarness = {
  readonly server: FixtureServer;
  readonly origin: string;
  readonly project: Project;
  // The harness's own drivers by adapter id, made once.
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  plan(raw: unknown): Plan;
  // One locator, parsed by the real parser so a direct probe gets branded values.
  locator(raw: JsonRecord): Locator;
  target(targetId: string): Target;
  run(plan: Plan, targetId: string, options?: RunOptions): Promise<PlanRun>;
  // planFor, parsed and run on the target.
  runSteps(targetId: string, steps: readonly unknown[], options?: RunOptions & { readonly fields?: JsonRecord }): Promise<PlanRun>;
  close(): Promise<void>;
};

export async function planValuesHarness(): Promise<PlanValuesHarness> {
  const requested: string[] = [];
  const server = await startFixtureServer(join(FIXTURES, 'plan-values-app'), (path) => { requested.push(path); });
  const projectFile = planValuesProjectFile(server.origin);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad plan-values project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const locator = (raw: JsonRecord): Locator => {
    const parsed = plan(planFor(CDP_TARGET, [navigate('/'), { type: 'expect', locator: raw, assert: { kind: 'visible' }, criterionId: 'probe.located' }]));
    const step = parsed.steps[1];
    assert.ok(step !== undefined && step.type === 'expect');
    return step.locator;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const drivers = planValuesDrivers();

  const readPage = (testIds: readonly string[]) => async (session: Session): Promise<PageAtClose> => {
    const shown: Record<string, string | null> = {};
    for (const id of testIds) {
      const probed = await session.probe(locator(testId(id)));
      shown[id] = probed.count === 1 ? probed.text : null;
    }
    return { url: (await session.page()).url, shown };
  };

  const runPlan = async (parsedPlan: Plan, targetId: string, options: RunOptions = {}): Promise<PlanRun> => {
    const chosen = options.drivers ?? drivers;
    const pages: PageAtClose[] = [];
    const read = readPage(options.read ?? ['input-events']);
    const reading = new Map([...chosen].map(([adapter, driver]) => [adapter, readingAtClose(driver, read, (page) => { pages.push(page); })] as const));
    const events = memoryRunEventSink();
    const audit = memoryEventSink();
    const store = memoryArtifactStore();
    const firstRequest = requested.length;
    // The target id comes from the trusted test project, so it is used as the branded value directly.
    const result = await run({
      project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: options.clockStartMilliseconds ?? CLOCK_START_MILLISECONDS,
      fixtures: server.fixtures, host: { platform: platform(), arch: arch() }, plan: authorise(parsedPlan, trusted), targetId: targetId as TargetId,
    }, {
      drivers: reading, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit, events,
    });
    return { result, events, audit, store, atClose: pages[0] ?? null, requestedPaths: requested.slice(firstRequest) };
  };

  return {
    server, origin: server.origin, project, drivers, plan, locator, target,
    run: runPlan,
    runSteps: (targetId, steps, options = {}) => runPlan(plan(planFor(targetId, steps, options.fields ?? {})), targetId, options),
    close: () => server.close(),
  };
}
