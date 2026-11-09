// Browser mutants: the egress proxy rewrites plain-HTTP responses from declared fixture origins,
// and only from them, and reports each rewrite it applied so the run manifest records it.
//
// Two copies of the same fixture page are served on two declared origins; only the first is a
// fixture origin with a rewrite. A real headless Chromium, through the own CDP driver, loads both
// through the in-process proxy: the first shows the mutated heading, the second, the
// counter-example, still shows the original.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { DriverSession } from '@revisum/driver-cdp';
import { createBrowserDriver } from '#test-support/browser/driver/CreateBrowserDriver.ts';
import { egressThrough } from '#test-support/browser/driver/SessionEgressForTest.ts';
import { buildManifest, defaultRedactor, type SessionEnvironment } from '@revisum/engine';
import { type EgressProxy, type ResponseRewrite } from '@revisum/runner';
import { startedEgressProxy } from '#test-support/StartedEgressProxy.ts';
import { BROWSERS } from '#test-support/browser/Browsers.ts';
import { createCleanUpScope } from '#test-support/CleanUpScope.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { FIXED_TIME_MILLISECONDS, SEED, capabilityHarness, type CapabilityHarness } from '#test-support/browser/harnesses/CapabilityHarness.ts';
import { defaultParser, signupPlan } from '../../unit/engine/plan/examples/GoldenPlan.ts';
import { startEgressFixtureServer, type EgressFixtureServer } from '../../unit/runner/support/EgressFixtureServer.ts';
import { declaredService, egressPolicy, fakeResolver, origin } from '../../unit/runner/examples/DeclaredService.ts';
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";

const HEADING_CHANGED: ResponseRewrite = { name: 'heading-changed', find: 'Original heading', replace: 'Mutated heading' };
const readHeading = (): string => document.querySelector('[data-testid="heading"]')?.textContent ?? '';

const cleanUps = createCleanUpScope();
let capability: CapabilityHarness;
let fixtureApp: EgressFixtureServer;
let secondApp: EgressFixtureServer;
let proxy: EgressProxy;
let session: DriverSession;

before(async () => {
  capability = await capabilityHarness(5000);
  cleanUps.add(() => capability.close());
  fixtureApp = await startEgressFixtureServer();
  cleanUps.add(() => fixtureApp.close());
  secondApp = await startEgressFixtureServer();
  cleanUps.add(() => secondApp.close());
  proxy = await startedEgressProxy({
    policy: egressPolicy({
      allowOrigins: [fixtureApp.origin, secondApp.origin], allowServices: ['fixture-app', 'second-app'], fixtureOrigins: [fixtureApp.origin],
      responseRewrites: [{ origin: fixtureApp.origin, rewrite: HEADING_CHANGED }],
    }),
    // Both apps listen on loopback, so both are declared as private services.
    services: [declaredService('fixture-app', fixtureApp.origin, true), declaredService('second-app', secondApp.origin, true)],
    resolve: fakeResolver({}).resolve,
  });
  cleanUps.add(() => proxy.close());
  const environment: SessionEnvironment = {
    baseUrl: baseUrlOf(fixtureApp.origin), allowedOrigins: [fixtureApp.origin, secondApp.origin], seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
  };
  const driver = createBrowserDriver({ executablePath: BROWSERS.chrome, egress: egressThrough(proxy) });
  const opened = await driver.open(capability.target(BrowserTarget.Chrome), environment);
  assert.ok(opened.ok, `the session opens: ${opened.ok ? '' : JSON.stringify(opened.error)}`);
  session = opened.value;
  cleanUps.add(() => session.close());
});
after(() => cleanUps.runAll());

test('counter-example: the same page on a declared origin that is not a fixture origin is not rewritten', async () => {
  const navigated = await session.navigate(secondApp.url('/mutant.html'), scriptsEnabled);
  assert.ok(navigated.ok, JSON.stringify(navigated));
  assert.equal(await session.evaluate(readHeading), 'Original heading');
  assert.deepEqual(proxy.rewritesApplied(), [], 'no rewrite has been applied yet');
});

test('the page on the fixture origin is rewritten by its browser mutant', async () => {
  const navigated = await session.navigate(fixtureApp.url('/mutant.html'), scriptsEnabled);
  assert.ok(navigated.ok, JSON.stringify(navigated));
  assert.equal(await session.evaluate(readHeading), 'Mutated heading');
});

test('the proxy reports the rewrite it applied, by origin and name, once', async () => {
  // Loading the fixture page again applies the same rewrite again; it is still one rewrite.
  assert.ok((await session.navigate(fixtureApp.url('/mutant.html'), scriptsEnabled)).ok);
  assert.deepEqual(proxy.rewritesApplied(), [{ origin: origin(fixtureApp.origin), name: 'heading-changed' }]);
});

test('the run manifest records the rewrites the proxy applied', () => {
  const parsed = defaultParser()(signupPlan());
  assert.ok(parsed.ok);
  const manifest = buildManifest({
    plan: parsed.value, target: capability.target(BrowserTarget.Chrome), adapter: { id: 'cdp', version: '0.1.0', protocol: 'Chrome DevTools Protocol (raw WebSocket)' },
    browser: { name: 'chromium', version: '156.0.8078.47' }, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
    fixtures: fixtureApp.fixtures, host: { platform: 'linux', arch: 'x64' }, responseRewrites: proxy.rewritesApplied(),
  });
  assert.deepEqual(manifest.responseRewrites, [{ origin: fixtureApp.origin, name: 'heading-changed' }]);
});
