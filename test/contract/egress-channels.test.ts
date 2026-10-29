// The egress proxy blocks every channel a page can use to reach an undeclared origin: an ordinary
// request, a WebSocket, a worker's request, a popup, a redirect and a beacon. Each fixture page
// sends one kind to a .invalid origin, so nothing can reach the network whatever happens.
//
// The proxy runs in-process and a real headless Chromium, through the own CDP driver, is pointed
// at it. The browser's own allow-list is deliberately widened to let every undeclared origin
// through, as a browser-level escape would, so the proxy outside the browser is all that stands in
// the way. The run's egress events join the browser's record of each request's channel with the
// proxy's decision. The fixture origin's own requests, allowed and recorded as allowed, are the
// counter-example that shows the proxy is not simply refusing everything.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cdpDriver, type DriverSession } from '@revisum/driver-cdp';
import { defaultRedactor, type SessionEnvironment } from '@revisum/engine';
import { joinEgressEvents, startEgressProxy, type EgressProxy } from '@revisum/runner';
import type { EgressEvent } from '@revisum/contracts';
import { BROWSERS } from '../support/browsers.ts';
import {
  CDP_TARGET, FIXED_TIME_MILLISECONDS, SEED, capabilityHarness, click, role, type CapabilityHarness,
} from '../support/capability-harness.ts';
import { startEgressFixtureServer, type EgressFixtureServer } from '../unit/runner/egress-fixture-server.ts';
import {
  CHANNEL_HOSTS, CHANNEL_NAMES, CHANNEL_PAGES, UNDECLARED_CHANNEL_ORIGINS, declaredService, egressPolicy, fakeResolver, hostOf,
  type ChannelName, type FakeResolver,
} from '../unit/runner/runner-examples.ts';

const WAIT_MILLISECONDS = 10_000;
const POLL_MILLISECONDS = 50;

let capability: CapabilityHarness;
let fixture: EgressFixtureServer;
let resolver: FakeResolver;
let proxy: EgressProxy;

before(async () => {
  capability = await capabilityHarness(5000);
  fixture = await startEgressFixtureServer();
  // No name is ever resolved: the fixture origin is an IP literal and every other origin is undeclared.
  resolver = fakeResolver({});
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: [fixture.origin], allowServices: ['fixture-app'] }),
    // The fixture app listens on loopback, so it is declared as a private service.
    services: [declaredService('fixture-app', fixture.origin, true)],
    resolve: resolver.resolve,
  });
});
after(async () => {
  await proxy?.close();
  await fixture?.close();
  await capability?.close();
});

// A browser allow-list that lets every channel's undeclared origin through, so only the proxy blocks.
const widenedEnvironment = (): SessionEnvironment => ({
  baseUrl: fixture.origin, allowedOrigins: [fixture.origin, ...UNDECLARED_CHANNEL_ORIGINS], seed: SEED,
  fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
});

async function openThroughProxy(): Promise<DriverSession> {
  const driver = cdpDriver({ executablePath: BROWSERS.chrome, proxy: { server: proxy.url, includeLoopback: true } });
  const opened = await driver.open(capability.target(CDP_TARGET), widenedEnvironment());
  assert.ok(opened.ok, `the session opens: ${opened.ok ? '' : JSON.stringify(opened.error)}`);
  return opened.value;
}

const eventsOf = (session: DriverSession): readonly EgressEvent[] => joinEgressEvents(session.egressRecords(), proxy.decisions());

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MILLISECONDS;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
}

// Opens the channel's page, makes it send its traffic, and returns the run's egress events once
// the expected one has appeared or the wait is over.
async function sendThrough(channel: ChannelName): Promise<{ readonly events: readonly EgressEvent[]; readonly session: DriverSession }> {
  const session = await openThroughProxy();
  const host = CHANNEL_HOSTS[channel];
  const navigated = await session.navigate(fixture.url(CHANNEL_PAGES[channel]));
  assert.ok(navigated.ok, JSON.stringify(navigated));
  if (channel === 'popup') await session.act(capability.actionStep(click(role('button', 'Open the partner site'))));
  await waitFor(() => eventsOf(session).some((event) => event.channel === channel && hostOf(String(event.origin)) === host));
  return { events: eventsOf(session), session };
}

describe('every channel to an undeclared origin is blocked and recorded as an egress event', () => {
  for (const channel of CHANNEL_NAMES) {
    const host = CHANNEL_HOSTS[channel];
    test(`${channel} traffic to ${host} is recorded as a blocked ${channel} event`, { criterion: 'AC-SPEC-07-01' }, async () => {
      const { events, session } = await sendThrough(channel);
      try {
        const forHost = events.filter((event) => hostOf(String(event.origin)) === host);
        assert.ok(forHost.some((event) => event.channel === channel && event.decision === 'blocked'), JSON.stringify(events));
        assert.deepEqual(forHost.filter((event) => event.decision === 'allowed'), [], 'nothing to the undeclared origin was let through');
        const proxyAllowed = proxy.decisions().filter((entry) => entry.decision === 'allowed' && hostOf(String(entry.origin)) === host);
        assert.deepEqual(proxyAllowed, [], 'the proxy let nothing through to the undeclared origin');
        assert.ok(!resolver.asked.includes(host), 'the undeclared name was never looked up');
      } finally {
        await session.close();
      }
    });
  }

  // A popup is held back by the driver before it loads (docs/specs/SPEC-06-cdp-driver.md), so
  // only the five other channels ever reach the proxy.
  for (const channel of CHANNEL_NAMES.filter((name) => name !== 'popup')) {
    const host = CHANNEL_HOSTS[channel];
    test(`the proxy itself blocks the ${channel} request that the widened browser let through`, { criterion: 'AC-SPEC-07-01' }, async () => {
      const { session } = await sendThrough(channel);
      try {
        await waitFor(() => proxy.decisions().some((entry) => hostOf(String(entry.origin)) === host));
        const decided = proxy.decisions().filter((entry) => hostOf(String(entry.origin)) === host);
        assert.ok(decided.length >= 1, `the proxy saw the ${channel} request: ${JSON.stringify(proxy.decisions())}`);
        assert.ok(decided.every((entry) => entry.decision === 'blocked'), JSON.stringify(decided));
      } finally {
        await session.close();
      }
    });
  }
});

test('counter-example: the fixture origin\'s own requests go through the proxy and are allowed', { criterion: 'AC-SPEC-07-01' }, async () => {
  const session = await openThroughProxy();
  try {
    const navigated = await session.navigate(fixture.url('/index.html'));
    assert.ok(navigated.ok, JSON.stringify(navigated));
    const allowed = proxy.decisions().filter((entry) => String(entry.origin) === fixture.origin && entry.decision === 'allowed');
    assert.ok(allowed.length >= 1, `the proxy recorded the fixture origin as allowed: ${JSON.stringify(proxy.decisions())}`);
    assert.ok(eventsOf(session).some((event) => String(event.origin) === fixture.origin && event.channel === 'page' && event.decision === 'allowed'));
  } finally {
    await session.close();
  }
});

test('counter-example: the redirect\'s first hop, to the fixture origin, is allowed before its second hop is blocked', { criterion: 'AC-SPEC-07-01' }, async () => {
  const { session } = await sendThrough('redirect');
  try {
    assert.ok(fixture.requested.includes('/leave'), 'the page asked its own origin for the redirecting path');
  } finally {
    await session.close();
  }
});
