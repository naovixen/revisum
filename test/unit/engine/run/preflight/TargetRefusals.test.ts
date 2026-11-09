// The shipped drivers explain a "no" for a target they cannot serve, and the engine reports it
// as the run's outcome: no other adapter, engine or device is tried, and no browser starts.
// Only `supports` is asked of a real driver here, so no browser is needed.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import {
  createRunService,
  adapterRegistry,
  parseProject,
  planParser,
  type BrowserDriver,
  type Project,
  type Target,
} from '@revisum/engine';
import { buildAdapters } from '../../../../../packages/cli/src/wiring/BuildAdapters.ts';
import { memoryArtifactStore, systemClock } from '../../../../support/builders/MemoryEventSink.ts';
import { baseUrlOf, clearRun, trustedProjectFrom } from '../../../../support/builders/ClearRun.ts';
import { fakePorts } from '../../../../support/fakes/FakePorts.ts';

const ORIGIN = 'http://127.0.0.1:4173';
// A one-check plan on one target, written as raw JSON the way a person writes it.
const headingPlan = (targetId: string) => ({
  version: '1.3',
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
    { id: 'appium-android', adapter: 'appium', engine: 'chromium', device: 'phone-390', ...environment },
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
  const result = await createRunService(fakePorts({ drivers, clock: systemClock, artifacts: store })).run(clearRun(parsed.value, await trustedProjectFrom(projectFile), target(targetId).id), {
    baseUrl: baseUrlOf(ORIGIN), seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
  });
  return { result, store };
}

test('when the only registered adapter is CDP, it refuses a WebKit target with engine-not-supported', () => {
  const registry = adapterRegistry(new Map([['cdp', buildAdapters.hostBrowserDriver({ executablePath: 'never-launched' })]]));
  for (const driver of registry.all()) {
    const answer = driver.supports(target('cdp-webkit'));
    assert.ok(!answer.ok);
    assert.equal(answer.error.reason, 'engine-not-supported');
  }
});

test('a WebKit run on CDP ends engine-not-supported; another registered adapter is not used instead', async () => {
  const cdp = watched(buildAdapters.hostBrowserDriver({ executablePath: 'never-launched' }));
  const bystander = watched(buildAdapters.hostBrowserDriver({ executablePath: 'never-launched' }));
  const { result, store } = await runOn('cdp-webkit', new Map<string, BrowserDriver>([['cdp', cdp], ['other', bystander]]));
  assert.equal(result.state, 'TargetUnavailable');
  assert.equal(result.unavailable.reason, 'engine-not-supported');
  assert.equal(cdp.opened + bystander.opened, 0, 'no browser was started');
  assert.equal(store.references().length, 0);
});

test('a run on an adapter nobody registered ends adapter-not-registered, and the registered CDP driver opens no browser', async () => {
  const cdp = watched(buildAdapters.hostBrowserDriver({ executablePath: 'never-launched' }));
  const { result, store } = await runOn('appium-android', new Map<string, BrowserDriver>([['cdp', cdp]]));
  assert.equal(result.state, 'TargetUnavailable');
  assert.equal(result.unavailable.reason, 'adapter-not-registered');
  assert.equal(cdp.opened, 0, 'no browser was started');
  assert.equal(result.manifest, null);
  assert.equal(store.references().length, 0);
});
