// The shipped drivers explain a "no" for a target they cannot serve, and the engine reports it
// as the run's outcome: no other adapter, engine or device is tried, and no browser starts.
// Only `supports` is asked of a real driver here, so no browser is needed.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  adapterRegistry, defaultRedactor, parseProject, planParser, run,
  type BrowserDriver, type Project, type Target,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';

const ORIGIN = 'http://127.0.0.1:4173';
// A one-check plan on one target, written as raw JSON the way a person writes it.
const headingPlan = (targetId: string) => ({
  version: '1.1',
  meta: { featureId: 'SIGNUP-1', specReference: 'specs/signup.md#happy-path', title: 'The sign-up form is shown' },
  targets: [targetId],
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'expect', locator: { by: 'role', role: 'heading', name: 'Create your account' }, assert: { kind: 'visible' }, criterionId: 'signup.heading-shown' },
  ],
});
const environment = { locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce' } as const;
const projectFile = {
  origins: [ORIGIN],
  limits: { stepTimeoutMilliseconds: 2000 },
  matrix: [
    { id: 'cdp-webkit', adapter: 'cdp', engine: 'webkit', device: 'desktop-1280', ...environment },
    { id: 'playwright-firefox-phone', adapter: 'playwright', engine: 'firefox', device: 'phone-390', ...environment },
    { id: 'playwright-firefox-desktop', adapter: 'playwright', engine: 'firefox', device: 'desktop-1280', ...environment },
  ],
};

function parsedProject(): Project {
  const parsed = parseProject(projectFile);
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}
const project = parsedProject();
const target = (id: string): Target => {
  const found = project.matrix.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no target ${id}`);
  return found;
};

// Wraps a real driver so the test sees whether `open` was ever called; it never is on a refusal.
function watched(driver: BrowserDriver): BrowserDriver & { opened: number } {
  const wrapper = {
    opened: 0,
    info: driver.info,
    supports: (asked: Target) => driver.supports(asked),
    open: async (...given: Parameters<BrowserDriver['open']>) => { wrapper.opened++; return driver.open(...given); },
  };
  return wrapper;
}

async function runOn(targetId: string, drivers: ReadonlyMap<string, BrowserDriver>) {
  const parsed = planParser(project)(headingPlan(targetId));
  if (!parsed.ok) throw new Error(`bad test plan: ${JSON.stringify(parsed.error)}`);
  const store = memoryArtifactStore();
  const result = await run({
    plan: authorise(parsed.value, await trustedProjectFrom(projectFile)), project, targetId: target(targetId).id,
    baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
  }, {
    drivers, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  });
  return { result, store };
}

test('when the only registered adapter is CDP, it refuses a WebKit target with engine-not-supported', { criterion: 'AC-SPEC-05-02' }, () => {
  const registry = adapterRegistry(new Map([['cdp', cdpDriver({ executablePath: 'never-launched' })]]));
  for (const driver of registry.all()) {
    const answer = driver.supports(target('cdp-webkit'));
    assert.ok(!answer.ok);
    assert.equal(answer.error.reason, 'engine-not-supported');
  }
});

test('a WebKit run on CDP ends engine-not-supported; Playwright, registered too, is not used instead', { criterion: 'AC-SPEC-05-02' }, async () => {
  const cdp = watched(cdpDriver({ executablePath: 'never-launched' }));
  const playwright = watched(playwrightDriver());
  const { result, store } = await runOn('cdp-webkit', new Map<string, BrowserDriver>([['cdp', cdp], ['playwright', playwright]]));
  assert.equal(result.state, 'TargetUnavailable');
  assert.equal(result.unavailable?.reason, 'engine-not-supported');
  assert.equal(cdp.opened + playwright.opened, 0, 'no browser was started');
  assert.equal(store.references().length, 0);
});

test('Playwright refuses Firefox with a phone profile as device-not-supported, and accepts it on desktop', { criterion: 'AC-SPEC-05-03' }, () => {
  const driver = playwrightDriver();
  const phone = driver.supports(target('playwright-firefox-phone'));
  assert.ok(!phone.ok);
  assert.equal(phone.error.reason, 'device-not-supported');
  assert.ok(driver.supports(target('playwright-firefox-desktop')).ok, 'control: the desktop profile is supported');
});

test('a Firefox phone run ends device-not-supported, and neither Playwright nor CDP opens a browser', { criterion: 'AC-SPEC-05-03' }, async () => {
  const cdp = watched(cdpDriver({ executablePath: 'never-launched' }));
  const playwright = watched(playwrightDriver());
  const { result, store } = await runOn('playwright-firefox-phone', new Map<string, BrowserDriver>([['cdp', cdp], ['playwright', playwright]]));
  assert.equal(result.state, 'TargetUnavailable');
  assert.equal(result.unavailable?.reason, 'device-not-supported');
  assert.equal(cdp.opened + playwright.opened, 0, 'nothing opened, on desktop or any other adapter');
  assert.equal(result.manifest, null);
  assert.equal(store.references().length, 0);
});
