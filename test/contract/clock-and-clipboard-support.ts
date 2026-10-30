// Shared setup for the browser tests of plan language 1.2's clock advances and clipboard checks:
// the driver parts of each, carried out by the own CDP driver's clock and clipboard ports, and
// refused by the Playwright fallback.
//
// It serves the clock-and-clipboard fixture app (fixtures/clock-and-clipboard-app/). Beside the
// app's files it answers two routes: /api/late-code, which answers in two parts 150 ms apart, so
// a copy that waits for it lands about 300 ms after its click; and /leaks.html, the leak page with
// a canary name made fresh for the harness.
//
// The trusted project's targets are the own CDP driver on Chrome for Testing and on its headless
// shell, and the Playwright fallback on Chromium, in London time. It declares one secret, for a
// fill whose value the leak page copies, and keeps the default clock and clipboard limits.
// Plans are written as raw JSON, parsed against the project, cleared through the policy gate and
// run with run(). Every run reads chosen test ids just before the run closes its session.
//
// Clock advances need the page's timers to be the determinism kit's virtual timers: the fixture
// pages register theirs as they load, and expect none to run until an advance.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
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
  type SessionEnvironment, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { startFixtureServer, type FixtureRoute, type FixtureServer } from '../support/fixture-server.ts';
import {
  memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore, type MemoryEventSink,
} from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import type { JsonRecord } from './plan-values-support.ts';

export {
  click, fill, label, navigate, outcomes, reference, role, testId, text, textEquals, valueEquals, type JsonRecord,
} from './plan-values-support.ts';

export const SEED = 34;
// The run's own clock start: 30 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.2';
export const STEP_TIMEOUT_MILLISECONDS = 3000;
// The longest real time one advanceClock step may take.
export const MAXIMUM_ADVANCE_REAL_MILLISECONDS = 2000;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
// The project defaults the harness keeps.
export const DEFAULT_MAXIMUM_TIMERS_PER_ADVANCE = 10_000;
export const DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS = 20_000;

export const CDP_TARGET = 'cdp-chromium';
export const HEADLESS_SHELL_TARGET = 'cdp-chromium-headless-shell';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';
export const CDP_TARGETS = [CDP_TARGET, HEADLESS_SHELL_TARGET] as const;

// The features this spec adds to the driver capability model.
export const CLOCK_AND_CLIPBOARD_FEATURES = ['clockControl', 'clipboard'] as const;
export type ClockAndClipboardFeature = (typeof CLOCK_AND_CLIPBOARD_FEATURES)[number];

// The secret the leak page's token field is filled with, and copies.
export const COPY_SECRET = 'CLIPBOARD_ACCESS_TOKEN';

// What the clipboard page's buttons copy.
export const INVITE_CODE = 'Invite code: HX-4471';
export const ADDRESS_LINES = ['Ada Lovelace', '12 St James Square', 'London'] as const;
export const LATE_CODE = 'Late code: QZ-2290';
export const LONG_TEXT_CHARACTERS = 25_000;

export const FIXTURE_FOLDER = join(FIXTURES, 'clock-and-clipboard-app');

const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

// The project file as a person writes it.
export const clockAndClipboardProjectFile = (origin: string) => ({
  origins: [origin],
  limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
  secretNames: [COPY_SECRET],
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: HEADLESS_SHELL_TARGET, adapter: 'cdp-headless-shell', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
});

export const clockAndClipboardDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome })],
  ['cdp-headless-shell', cdpDriver({ executablePath: BROWSERS.chromeHeadlessShell })],
  ['playwright', playwrightDriver()],
]);

// ---- Plans, written as raw JSON -------------------------------------------------------------

export const advanceClock = (amount: number, unit: string, mode?: 'runTimers' | 'skipAhead'): JsonRecord =>
  ({ type: 'advanceClock', by: { amount, unit }, ...(mode === undefined ? {} : { mode }) });
export const expectClipboard = (kind: 'textEquals' | 'textContains' | 'textExcludes', value: unknown, criterionId: string): JsonRecord =>
  ({ type: 'expectClipboard', assert: { kind, value }, criterionId });
export const rememberClipboard = (name: string): JsonRecord => ({ type: 'remember', name, from: { clipboard: 'text' } });
export const absent = (locator: JsonRecord, criterionId: string): JsonRecord => ({ type: 'expect', locator, assert: { kind: 'absent' }, criterionId });
export const newTab = (url: string, steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url, steps });
export const frame = (locator: JsonRecord, steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator, steps });
export const capture = (name: string): JsonRecord => ({ type: 'capture', name });
export const secretValue = (secretName: string): JsonRecord => ({ secretName });

// A raw 1.2 plan for one target. `fields` adds top-level fields, such as `values` or `clock`.
// A plan must assert something; every test plan here does.
export const clockPlan = (targetId: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: { featureId: 'CLOCK-1', specReference: 'specs/clock-and-clipboard.md#driver', title: 'Clock advances and clipboard checks in a browser' },
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

// Personal data made fresh for one harness, which the leak page shows and copies. It begins with
// no step type, field or header name, so a leak scan's prefix check can only match the value.
export type Canaries = { readonly contactName: string };

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
  const routes = new Map<string, FixtureRoute>();
  routes.set('/api/late-code', () => ({
    headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('QZ-'), Buffer.from('2290')], chunkPauseMilliseconds: 150,
  }));
  const leaksTemplate = readFileSync(join(FIXTURE_FOLDER, 'leaks.html'), 'utf8');
  routes.set('/leaks.html', () => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: leaksTemplate.replace('CONTACT_NAME', canaries.contactName) }));
  return routes;
}

// ---- Wrapping a driver's sessions -----------------------------------------------------------

// Wraps a driver so every session it opens is replaced by what `wrap` makes of it.
export function wrappingSessions(inner: BrowserDriver, wrap: (session: Session) => Session): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        return { ok: true as const, value: wrap(opened.value) };
      };
    },
  });
}

// A session whose named members are replaced, and whose other members are the session's own.
export function sessionWith(session: Session, replaced: Readonly<Record<string, unknown>>): Session {
  return new Proxy(session, {
    get(sessionTarget, key) {
      if (typeof key === 'string' && Object.hasOwn(replaced, key)) return replaced[key];
      const value: unknown = Reflect.get(sessionTarget, key, sessionTarget);
      return typeof value === 'function' ? value.bind(sessionTarget) : value;
    },
  });
}

// A port object whose named methods are replaced, and whose other members are the port's own.
export function portWith(port: unknown, replaced: Readonly<Record<string, unknown>>): unknown {
  if (typeof port !== 'object' || port === null) return port;
  return new Proxy(port, {
    get(portTarget, key) {
      if (typeof key === 'string' && Object.hasOwn(replaced, key)) return replaced[key];
      const value: unknown = Reflect.get(portTarget, key, portTarget);
      return typeof value === 'function' ? value.bind(portTarget) : value;
    },
  });
}

// What the engine asked of a session, in order: 'act' and 'download' for each action, 'guard' for
// each time the driver asked the runtime guard, and 'advance-start' and 'advance-end' around
// each call of the clock port's advance.
export type SessionCallRecorder = { readonly driver: BrowserDriver; readonly calls: readonly string[] };

export function recordingSessionCalls(inner: BrowserDriver): SessionCallRecorder {
  const calls: string[] = [];
  const guarded = (guard: unknown): unknown => {
    if (typeof guard !== 'function') return guard;
    return (...guardArguments: unknown[]): unknown => { calls.push('guard'); return Reflect.apply(guard, undefined, guardArguments); };
  };
  const driver = wrappingSessions(inner, (session) => {
    const clock: unknown = Reflect.get(session, 'clock', session);
    const advance: unknown = typeof clock === 'object' && clock !== null ? Reflect.get(clock, 'advance', clock) : undefined;
    const replaced: Record<string, unknown> = {
      act: (step: unknown, guard: unknown, secret: unknown) => {
        calls.push('act');
        return Reflect.apply(session.act, session, [step, guarded(guard), secret]);
      },
    };
    if (session.download !== undefined) {
      const download = session.download;
      replaced['download'] = (step: unknown, maximumBytes: unknown, guard: unknown) => {
        calls.push('download');
        return Reflect.apply(download, session, [step, maximumBytes, guarded(guard)]);
      };
    }
    if (typeof advance === 'function') {
      replaced['clock'] = portWith(clock, {
        advance: async (...advanceArguments: unknown[]): Promise<unknown> => {
          calls.push('advance-start');
          try { return await Reflect.apply(advance, clock, advanceArguments); } finally { calls.push('advance-end'); }
        },
      });
    }
    return sessionWith(session, replaced);
  });
  return { driver, calls };
}

// ---- The harness ----------------------------------------------------------------------------

// What the page showed just before the run closed its session: its URL, and the text of each
// test id the run was asked to read (null when that test id matched no single element).
export type PageAtClose = { readonly url: string; readonly shown: Readonly<Record<string, string | null>> };

export type ClockRun = {
  readonly result: RunResult;
  readonly events: RunEventSink;
  readonly audit: MemoryEventSink;
  readonly store: MemoryArtifactStore;
  // Null when no session opened, or it was never closed.
  readonly atClose: PageAtClose | null;
  // The paths the fixture server was asked for during the run, in order.
  readonly requestedPaths: readonly string[];
};

export type ClockRunOptions = {
  // Test ids whose text to read at close; the input-event counter by default.
  readonly read?: readonly string[];
  // Drivers by adapter id, in place of the harness's own.
  readonly drivers?: ReadonlyMap<string, BrowserDriver>;
  // Where the plan's secrets are resolved.
  readonly secrets?: SecretStore;
};

export type ClockHarness = {
  readonly server: FixtureServer;
  readonly origin: string;
  readonly project: Project;
  // The harness's own drivers by adapter id, made once.
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  readonly canaries: Canaries;
  plan(raw: unknown): Plan;
  locator(raw: JsonRecord): Locator;
  target(targetId: string): Target;
  run(plan: Plan, targetId: string, options?: ClockRunOptions): Promise<ClockRun>;
  // clockPlan, parsed and run on the target.
  runSteps(targetId: string, steps: readonly unknown[], options?: ClockRunOptions & { readonly fields?: JsonRecord }): Promise<ClockRun>;
  url(path: string): string;
  close(): Promise<void>;
};

export async function clockHarness(): Promise<ClockHarness> {
  const nonce = randomBytes(5).toString('hex');
  const canaries: Canaries = { contactName: `Zqcontact${nonce} Ellery` };
  const requested: string[] = [];
  const server = await startFixtureServer(FIXTURE_FOLDER, (path) => { requested.push(path); }, routesFor(canaries));
  const projectFile = clockAndClipboardProjectFile(server.origin);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad clock-and-clipboard project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const locator = (raw: JsonRecord): Locator => {
    const parsed = plan(clockPlan(CDP_TARGET, [{ type: 'navigate', url: '/' }, { type: 'expect', locator: raw, assert: { kind: 'visible' }, criterionId: 'probe.located' }]));
    const step = parsed.steps[1];
    assert.ok(step !== undefined && step.type === 'expect');
    return step.locator;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const drivers = clockAndClipboardDrivers();

  const readPage = async (session: Session, testIds: readonly string[]): Promise<PageAtClose> => {
    const shown: Record<string, string | null> = {};
    for (const id of testIds) {
      const probed = await session.probe(locator({ by: 'testId', testId: id }));
      shown[id] = probed.count === 1 ? probed.text : null;
    }
    return { url: (await session.page()).url, shown };
  };

  const runPlan = async (parsedPlan: Plan, targetId: string, options: ClockRunOptions = {}): Promise<ClockRun> => {
    const chosen = options.drivers ?? drivers;
    const pages: PageAtClose[] = [];
    const testIds = options.read ?? ['input-events'];
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
      fixtures: server.fixtures, host: { platform: platform(), arch: arch() }, plan: authorise(parsedPlan, trusted), targetId: targetId as TargetId,
    }, {
      drivers: reading, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit, events,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    });
    return { result, events, audit, store, atClose: pages[0] ?? null, requestedPaths: requested.slice(firstRequest) };
  };

  return {
    server, origin: server.origin, project, drivers, canaries, plan, locator, target,
    run: runPlan,
    runSteps: (targetId, steps, options = {}) => runPlan(plan(clockPlan(targetId, steps, options.fields ?? {})), targetId, options),
    url: (path) => `${server.origin}${path}`,
    close: () => server.close(),
  };
}

// The features a driver lists, as plain names.
export const listedFeatures = (driver: BrowserDriver | undefined): readonly string[] => {
  assert.ok(driver !== undefined, 'the harness has the driver');
  return (driver.info.performs ?? []).map((feature) => String(feature));
};

// The harness's drivers with the own CDP driver's list lacking one feature, and nothing else changed.
export function cdpWithout(harness: ClockHarness, feature: ClockAndClipboardFeature): ReadonlyMap<string, BrowserDriver> {
  const inner = harness.drivers.get('cdp');
  assert.ok(inner !== undefined);
  const performs = (inner.info.performs ?? []).filter((listed) => String(listed) !== feature);
  const lacking = new Proxy(inner, {
    get: (target, key) => (key === 'info' ? { ...target.info, performs } : Reflect.get(target, key, target)),
  });
  return new Map([...harness.drivers, ['cdp', lacking]]);
}
