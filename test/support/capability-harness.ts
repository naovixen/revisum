// Shared setup for the CDP driver's capability tests: the capability fixture app, a trusted project
// whose targets are the own CDP driver on Chrome for Testing and on its headless shell, and the
// Playwright fallback on Chromium, with helpers to run plans, open sessions directly, parse single
// steps, and watch the processes a driver started.
//
// The project declares one upload file, upload-note.txt, which lives in fixtures/capability-uploads/
// (the project's fixtures folder); the CDP driver is told where that folder is.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { cdpDriver, type CdpDriverOptions, type DriverSession, type OwnBrowserDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type ActionStep, type BrowserDriver, type Locator, type Plan, type Project, type Session, type SessionEnvironment,
  type Step, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from './browsers.ts';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from './memory-ports.ts';
import { authorise, trustedProjectFrom } from './policy-clearance.ts';
import { processTree, stillRunning, type RunningProcess } from './process-tree.ts';
import { FIXTURES } from './repository.ts';
import type { Ran } from './signup-harness.ts';

export const SEED = 11;
export const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 9, 29, 9, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.1';

export const CDP_TARGET = 'cdp-chromium';
export const HEADLESS_SHELL_TARGET = 'cdp-chromium-headless-shell';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';
// Both targets of the own CDP driver: the same driver with a different executable.
export const CDP_TARGETS = [CDP_TARGET, HEADLESS_SHELL_TARGET] as const;

export const UPLOAD_FIXTURE = 'upload-note.txt';
export const UPLOAD_FOLDER = join(FIXTURES, 'capability-uploads');
export const UPLOAD_CONTENT = 'Upload fixture note: twelve green bottles.';

// English, so the engine's built-in English irreversible patterns apply to the runtime guard.
const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

export const capabilityProjectFile = (origin: string, stepTimeoutMilliseconds: number) => ({
  origins: [origin],
  // A capability test repeats its steps 20 times in one plan, in one browser.
  limits: { stepTimeoutMilliseconds, maximumSteps: 400 },
  fixtures: [UPLOAD_FIXTURE],
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: HEADLESS_SHELL_TARGET, adapter: 'cdp-headless-shell', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
});

// The CDP driver for one executable, told where the project's upload files are.
export function capabilityCdpDriver(executablePath: string): OwnBrowserDriver {
  const options: CdpDriverOptions & { readonly fixturesFolder: string } = { executablePath, fixturesFolder: UPLOAD_FOLDER };
  return cdpDriver(options);
}

export const capabilityDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', capabilityCdpDriver(BROWSERS.chrome)],
  ['cdp-headless-shell', capabilityCdpDriver(BROWSERS.chromeHeadlessShell)],
  ['playwright', playwrightDriver()],
]);

// The own CDP driver that serves a target, by the target's adapter.
export function ownDriverFor(targetId: string): OwnBrowserDriver {
  assert.ok(targetId === CDP_TARGET || targetId === HEADLESS_SHELL_TARGET, `${targetId} is not a CDP target`);
  return capabilityCdpDriver(targetId === CDP_TARGET ? BROWSERS.chrome : BROWSERS.chromeHeadlessShell);
}

// ---- Plans ------------------------------------------------------------------------------------

const meta = (title: string) => ({ featureId: 'CAPABILITY-1', specReference: 'specs/capabilities.md#driver', title });
export const role = (roleName: string, name: string) => ({ by: 'role', role: roleName, name });
export const label = (labelText: string) => ({ by: 'label', label: labelText });
export const testId = (id: string) => ({ by: 'testId', testId: id });
export const navigate = (path: string) => ({ type: 'navigate', url: path });
export const click = (locator: object) => ({ type: 'click', locator });
export const textEquals = (locator: object, value: string, criterionId: string) =>
  ({ type: 'expect', locator, assert: { kind: 'textEquals', value }, criterionId });

// A plan for one target with the given steps. A plan must assert something; every test plan here does.
export const capabilityPlan = (targetId: string, steps: readonly unknown[]) =>
  ({ version: PLAN_LANGUAGE_VERSION, meta: meta('Driver capability'), targets: [targetId], steps });

const ACTION_STEP_TYPES: readonly string[] = ['click', 'hover', 'fill', 'select', 'upload', 'press', 'download', 'dialog'];
const isActionStep = (step: Step): step is ActionStep => ACTION_STEP_TYPES.includes(step.type);

// ---- Watching a driver ------------------------------------------------------------------------

// What a watched driver saw of one session it opened.
export type WatchedSession = {
  readonly processId: number;
  // Every process below the browser just before close() was called.
  processesBeforeClose: readonly RunningProcess[];
  // Those of them still running at the moment close() returned.
  stillRunningAfterClose: readonly RunningProcess[];
  closeCalls: number;
  closeError: unknown;
  // What `beforeClose` read from the page, if anything.
  readBeforeClose: string | null;
};

export type WatchedDriver = {
  readonly driver: BrowserDriver;
  readonly sessions: readonly WatchedSession[];
  // Resolves with the session's browser process id as soon as a session is open.
  opened(): Promise<number>;
};

// Wraps an own CDP driver so a test can see the browser process of each session it opens, and
// what is still running when its close() returns. `beforeClose` may read the page first.
export function watchedDriver(inner: OwnBrowserDriver, beforeClose?: (session: DriverSession) => Promise<string>): WatchedDriver {
  const sessions: WatchedSession[] = [];
  let announce: (processId: number) => void = () => undefined;
  const firstOpen = new Promise<number>((resolve) => { announce = resolve; });
  const driver = new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const watched: WatchedSession = {
          processId: session.processId, processesBeforeClose: [], stillRunningAfterClose: [], closeCalls: 0, closeError: null, readBeforeClose: null,
        };
        sessions.push(watched);
        announce(session.processId);
        const close = async (): Promise<void> => {
          watched.closeCalls += 1;
          if (beforeClose !== undefined) {
            try { watched.readBeforeClose = await beforeClose(session); } catch (error) { watched.readBeforeClose = `read failed: ${String(error)}`; }
          }
          watched.processesBeforeClose = processTree(session.processId);
          try { await session.close(); } catch (error) { watched.closeError = error; }
          watched.stillRunningAfterClose = stillRunning(watched.processesBeforeClose);
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
  return { driver, sessions, opened: () => firstOpen };
}

// ---- The harness ------------------------------------------------------------------------------

export type CapabilityHarness = {
  readonly server: FixtureServer;
  readonly project: Project;
  readonly stepTimeoutMilliseconds: number;
  plan(raw: unknown): Plan;
  // One action step, parsed by the real parser so a direct session call gets branded values.
  actionStep(raw: object): ActionStep;
  // One locator, parsed the same way, for direct probes.
  locator(raw: object): Locator;
  target(targetId: string): Target;
  environment(): SessionEnvironment;
  run(plan: Plan, targetId: string, drivers?: ReadonlyMap<string, BrowserDriver>): Promise<Ran>;
  // Opens a session on the target's driver directly, outside a run.
  open(targetId: string): Promise<Session>;
  // Opens a session on a target of the own CDP driver, with its process id and page evaluation.
  openOwn(targetId: string): Promise<DriverSession>;
  // Resolves the next time a page asks the fixture server for this path.
  requested(path: string): Promise<void>;
  url(path: string): string;
  close(): Promise<void>;
};

export async function capabilityHarness(stepTimeoutMilliseconds = 2000): Promise<CapabilityHarness> {
  const waiting = new Map<string, (() => void)[]>();
  const server = await startFixtureServer(join(FIXTURES, 'capability-app'), (path) => {
    const waiters = waiting.get(path) ?? [];
    waiting.delete(path);
    for (const resume of waiters) resume();
  });
  const projectFile = capabilityProjectFile(server.origin, stepTimeoutMilliseconds);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad capability project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const singleStep = (raw: object): Step => {
    const parsed = plan(capabilityPlan(CDP_TARGET, [
      navigate('/'), raw, { type: 'expect', locator: role('heading', 'Capability fixtures'), assert: { kind: 'visible' }, criterionId: 'probe.page-shown' },
    ]));
    const step = parsed.steps[1];
    assert.ok(step !== undefined);
    return step;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const environment = (): SessionEnvironment => ({
    baseUrl: server.origin, allowedOrigins: project.origins, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
    sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: stepTimeoutMilliseconds,
  });
  const drivers = capabilityDrivers();
  return {
    server, project, stepTimeoutMilliseconds, plan, target, environment,
    actionStep(raw) {
      const step = singleStep(raw);
      assert.ok(isActionStep(step), `${step.type} is not an action step`);
      return step;
    },
    locator(raw) {
      const step = singleStep({ type: 'expect', locator: raw, assert: { kind: 'visible' }, criterionId: 'probe.located' });
      assert.ok(step.type === 'expect');
      return step.locator;
    },
    async run(parsedPlan, targetId, chosenDrivers = drivers) {
      const events = memoryRunEventSink();
      const store = memoryArtifactStore();
      // The target id comes from the trusted test project, so it is used as the branded value directly.
      const result = await run({
        project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, fixtures: server.fixtures,
        host: { platform: platform(), arch: arch() }, plan: authorise(parsedPlan, trusted), targetId: targetId as TargetId,
      }, {
        drivers: chosenDrivers, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit: memoryEventSink(), events,
      });
      return { result, events, store };
    },
    async open(targetId) {
      const chosen = target(targetId);
      const driver = drivers.get(chosen.adapter);
      assert.ok(driver, `no driver for ${chosen.adapter}`);
      const opened = await driver.open(chosen, environment());
      assert.ok(opened.ok, `the session opens: ${opened.ok ? '' : JSON.stringify(opened.error)}`);
      return opened.value;
    },
    async openOwn(targetId) {
      const opened = await ownDriverFor(targetId).open(target(targetId), environment());
      assert.ok(opened.ok, `the session opens: ${opened.ok ? '' : JSON.stringify(opened.error)}`);
      return opened.value;
    },
    requested(path) {
      return new Promise((resolve) => { waiting.set(path, [...(waiting.get(path) ?? []), resolve]); });
    },
    url: (path) => `${server.origin}${path}`,
    close: () => server.close(),
  };
}

// The text of the one element a test id names, read through the session's own probe.
export async function shownText(harness: CapabilityHarness, session: Session, id: string): Promise<string> {
  return (await session.probe(harness.locator(testId(id)))).text;
}
