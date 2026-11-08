// A hostile page script cannot reach an undeclared origin: its fetch, its WebSocket and its beacon
// are each blocked by the egress proxy and recorded as blocked egress events. The proxy runs
// in-process and a real headless Chromium, through the own CDP driver, is pointed at it, as in
// stub-egress.test.ts. The project's allow-list is widened to page.invalid and beacon.invalid, so
// the browser lets those requests through and only the proxy stands in the way; a WebSocket is
// never held by the browser's own request filter, so it reaches the proxy too.
// The declared script hostileEgress (fixtures/unsafe-features-project/plans/scripts/) first fetches
// a file on the page's own origin: that request is allowed and reaches the server, the
// counter-example that shows the script's requests do go through the proxy.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createBrowserDriver } from '#test-support/browser/CreateBrowserDriver.ts';
import { keepingBrowserRecords } from '#test-support/browser/KeepingBrowserRecords.ts';
import { egressThrough } from '#test-support/browser/SessionEgressForTest.ts';
import type { BrowserDriver, BrowserRequestRecord, EgressEvent } from '@revisum/engine';
import { hostAndPort, joinEgressEvents, type EgressProxy } from '@revisum/runner';
import { startedEgressProxy } from '#test-support/StartedEgressProxy.ts';
import { BROWSERS } from '#test-support/browsers.ts';
import { createCleanUpScope } from '#test-support/CleanUpScope.ts';
import { declaredService, egressPolicy, fakeResolver, hostOf, type FakeResolver } from '../unit/runner/runner-examples.ts';
import type { BrowserRun } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { navigate, testId } from '#test-support/browser/RawPlan.ts';
import { check, evaluate, unsafePageHarness, type UnsafePageHarness } from './unsafe-page-support.ts';

const TIMEOUT = 120_000;
const WAIT_MILLISECONDS = 10_000;
const POLL_MILLISECONDS = 50;

// The undeclared hosts the script tries, by the channel each is sent on.
const SCRIPT_CHANNELS = [
  { channel: 'page', host: 'page.invalid', what: 'fetch' },
  { channel: 'websocket', host: 'socket.invalid', what: 'WebSocket' },
  { channel: 'beacon', host: 'beacon.invalid', what: 'beacon' },
] as const;

const cleanUps = createCleanUpScope();
let harness: UnsafePageHarness;
let resolver: FakeResolver;
let proxy: EgressProxy;

before(async () => {
  harness = await unsafePageHarness({ extraOrigins: ['http://page.invalid', 'http://beacon.invalid'] });
  cleanUps.add(() => harness.close());
  // No name is ever resolved: the fixture origin is an IP literal and every other origin is undeclared.
  resolver = fakeResolver({});
  proxy = await startedEgressProxy({
    policy: egressPolicy({ allowOrigins: [harness.origin], allowServices: ['fixture-app'] }),
    // The fixture app listens on loopback, so it is declared as a private service.
    services: [declaredService('fixture-app', harness.origin, true)],
    resolve: resolver.resolve,
  });
  cleanUps.add(() => proxy.close());
});
after(() => cleanUps.runAll());

type ProxiedRun = BrowserRun & { readonly egressEvents: () => readonly EgressEvent[]; readonly decisions: () => ReturnType<EgressProxy['decisions']> };

// Runs the hostile script through the proxy. The run's egress events join this run's browser
// records with this run's proxy decisions only, read again on each call, since the proxy may decide
// on a late beacon after the run.
async function runHostileScript(): Promise<ProxiedRun> {
  const records: BrowserRequestRecord[] = [];
  const driver = createBrowserDriver({ executablePath: BROWSERS.chrome, egress: egressThrough(proxy) });
  const drivers = new Map<string, BrowserDriver>([['cdp', keepingBrowserRecords(driver, (kept) => { records.push(...kept); })]]);
  const firstDecision = proxy.decisions().length;
  const ran = await harness.runSteps(BrowserTarget.Chrome, [navigate('/'), evaluate('hostileEgress', {}), check(testId('continue-state'), { kind: 'textEquals', value: 'Not continued' }, 'egress.page-untouched')], { drivers });
  const decisions = () => proxy.decisions().slice(firstDecision);
  return { ...ran, decisions, egressEvents: () => joinEgressEvents(records, decisions()) };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MILLISECONDS;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
}

let hostile: ProxiedRun | undefined;
// One run of the hostile script serves every test: each reads its own part of what was recorded.
async function hostileRun(): Promise<ProxiedRun> {
  hostile ??= await runHostileScript();
  return hostile;
}

for (const { channel, host, what } of SCRIPT_CHANNELS) {
  test(`the script's ${what} to ${host} is blocked by the proxy and recorded as a blocked ${channel} event`, { timeout: TIMEOUT }, async () => {
    const ran = await hostileRun();
    await waitFor(() => ran.decisions().some((entry) => hostOf(String(entry.origin)) === host));
    const decided = ran.decisions().filter((entry) => hostOf(String(entry.origin)) === host);
    assert.ok(decided.length >= 1, `the proxy saw the ${what}: ${JSON.stringify(ran.decisions())}`);
    assert.ok(decided.every((entry) => entry.decision === 'blocked'), JSON.stringify(decided));
    const events = ran.egressEvents().filter((event) => hostOf(String(event.origin)) === host);
    assert.ok(events.some((event) => event.channel === channel && event.decision === 'blocked'), `a blocked ${channel} event: ${JSON.stringify(ran.egressEvents())}`);
    assert.deepEqual(events.filter((event) => event.decision === 'allowed'), [], 'nothing to the undeclared origin was let through');
    assert.ok(!resolver.asked.includes(host), 'the undeclared name was never looked up');
  });
}

test('counter-example: the script\'s fetch of its own origin goes through the proxy, is allowed and reaches the server', { timeout: TIMEOUT }, async () => {
  const ran = await hostileRun();
  assert.ok(ran.requestedPaths.includes('/egress-allowed.json'), `the server received the script's request: ${JSON.stringify(ran.requestedPaths)}`);
  const own = new URL(harness.origin);
  const ownHost = `${own.hostname}:${own.port}`;
  assert.ok(ran.decisions().some((entry) => hostAndPort(String(entry.origin)) === ownHost && entry.decision === 'allowed'), JSON.stringify(ran.decisions()));
  assert.ok(ran.egressEvents().some((event) => hostAndPort(event.origin) === ownHost && event.decision === 'allowed'), JSON.stringify(ran.egressEvents()));
});
