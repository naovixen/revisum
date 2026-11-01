// A popup never loads. The driver holds it back before it sends anything, so a popup to a host that
// is declared and reachable leaves that host's server with no request, and the run's egress events
// say blocked. A real headless Chromium, through the own CDP driver, is pointed at the in-process
// proxy, and both sites are real servers on loopback.
// The counter-example goes to the same server directly from the same page: the server gets its
// request and the proxy allows it, so the server can be reached and the empty list above means
// something. That allowed decision is then the popup origin's only one, and the popup stays blocked.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md and docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { cdpDriver, type DriverSession } from '@revisum/driver-cdp';
import { defaultRedactor, type SessionEnvironment } from '@revisum/engine';
import { joinEgressEvents, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { BROWSERS } from '../support/browsers.ts';
import { CDP_TARGET, FIXED_TIME_MILLISECONDS, SEED, capabilityHarness, click, role, type CapabilityHarness } from '../support/capability-harness.ts';
import { declaredService, egressPolicy, fakeResolver } from '../unit/runner/runner-examples.ts';

const WAIT_MILLISECONDS = 10_000;
const POLL_MILLISECONDS = 50;
// Longer than the driver gives a popup to ask for its first page, so a popup that was let load has
// had time to reach the server.
const POPUP_SETTLE_MILLISECONDS = 2_000;
const OPEN_BUTTON = 'Open the partner site';

type Site = { readonly origin: string; readonly requested: string[]; close(): Promise<void> };

// A real server that answers every path with the page and notes each path it was asked for.
async function startSite(page: () => string): Promise<Site> {
  const requested: string[] = [];
  const server = createServer((incoming, response) => {
    requested.push(new URL(incoming.url ?? '/', 'http://localhost').pathname);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`, requested,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

let capability: CapabilityHarness;
let reachable: Site;
let opener: Site;
let proxy: EgressProxy;

before(async () => {
  capability = await capabilityHarness(5000);
  reachable = await startSite(() => '<!doctype html><html lang="en"><title>Partner</title><h1>Partner</h1></html>');
  opener = await startSite(() => `<!doctype html><html lang="en"><title>Opener</title><h1>Opener</h1>
    <button type="button" onclick="window.open('${reachable.origin}/welcome', 'partner', 'width=400,height=300')">${OPEN_BUTTON}</button></html>`);
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: [opener.origin, reachable.origin], allowServices: ['opener-site', 'partner-site'] }),
    // Both sites listen on loopback, so both are declared as private services.
    services: [declaredService('opener-site', opener.origin, true), declaredService('partner-site', reachable.origin, true)],
    resolve: fakeResolver({}).resolve,
  });
});
after(async () => {
  await proxy?.close();
  await reachable?.close();
  await opener?.close();
  await capability?.close();
});

async function openSession(): Promise<DriverSession> {
  const environment: SessionEnvironment = {
    baseUrl: opener.origin, allowedOrigins: [opener.origin, reachable.origin], seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
    sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
  };
  const driver = cdpDriver({ executablePath: BROWSERS.chrome, proxy: { server: proxy.url, includeLoopback: true } });
  const opened = await driver.open(capability.target(CDP_TARGET), environment);
  assert.ok(opened.ok, `the session opens: ${opened.ok ? '' : JSON.stringify(opened.error)}`);
  return opened.value;
}

// Clicks the button that opens the popup, and waits until the browser has reported it and any load
// it was let make has had time to arrive.
async function openPopup(session: DriverSession): Promise<void> {
  const navigated = await session.navigate(`${opener.origin}/`);
  assert.ok(navigated.ok, JSON.stringify(navigated));
  await session.act(capability.actionStep(click(role('button', OPEN_BUTTON))));
  const deadline = Date.now() + WAIT_MILLISECONDS;
  const reported = (): boolean => session.egressRecords().some((entry) => entry.channel === 'popup' && entry.origin === reachable.origin);
  while (!reported() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
  assert.ok(reported(), `the browser reported the popup: ${JSON.stringify(session.egressRecords())}`);
  await new Promise((resolve) => setTimeout(resolve, POPUP_SETTLE_MILLISECONDS));
}

test('a popup to a reachable host leaves that host\'s server with no request, and the proxy with no decision', { criterion: 'AC-SPEC-07-01' }, async () => {
  const session = await openSession();
  try {
    await openPopup(session);
    assert.deepEqual(reachable.requested, []);
    assert.deepEqual(proxy.decisions().filter((entry) => entry.origin === reachable.origin), []);
    const events = joinEgressEvents(session.egressRecords(), proxy.decisions());
    assert.deepEqual(events.filter((event) => event.channel === 'popup'), [{ origin: reachable.origin, channel: 'popup', decision: 'blocked' }]);
  } finally {
    await session.close();
  }
});

test('counter-example: the same server gets a direct request, and the popup that came first stays blocked', { criterion: 'AC-SPEC-07-01' }, async () => {
  const session = await openSession();
  try {
    await openPopup(session);
    const navigated = await session.navigate(`${reachable.origin}/welcome`);
    assert.ok(navigated.ok, JSON.stringify(navigated));
    assert.ok(reachable.requested.includes('/welcome'), JSON.stringify(reachable.requested));
    assert.ok(proxy.decisions().some((entry) => entry.origin === reachable.origin && entry.decision === 'allowed'), JSON.stringify(proxy.decisions()));
    const forSite = joinEgressEvents(session.egressRecords(), proxy.decisions()).filter((event) => event.origin === reachable.origin);
    assert.deepEqual(forSite.filter((event) => event.channel === 'popup').map((event) => event.decision), ['blocked']);
    assert.ok(forSite.some((event) => event.channel === 'page' && event.decision === 'allowed'), JSON.stringify(forSite));
  } finally {
    await session.close();
  }
});
