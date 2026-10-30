// A stubbed request never leaves the browser, so it is no egress event, while every other request
// still goes through the egress proxy, which allows or blocks it. The proxy runs in-process and a
// real headless Chromium, through the own CDP driver, is pointed at it, as in
// egress-channels.test.ts. The project allows blocked.invalid, so the browser lets it through
// and only the proxy stands in the way.
//
// What counts: the run's egress events, made by joining the browser's record of each request
// with the proxy's decisions. A request the browser recorded that never reached the proxy would
// show as an extra "blocked" event, so each test compares the fixture origin's events with what
// the fixture server received. The counter-example runs the same page without the stub: the same
// three requests then reach the server and add three allowed events.
// A script, style sheet, frame, worker or image that matches a stub also goes through the proxy.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md and
// docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cdpDriver, type OwnBrowserDriver } from '@revisum/driver-cdp';
import type { BrowserDriver, BrowserRequestRecord, EgressEvent, SessionEnvironment, Target } from '@revisum/engine';
import { hostAndPort, joinEgressEvents, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { BROWSERS } from '../support/browsers.ts';
import { declaredService, egressPolicy, fakeResolver, hostOf, type FakeResolver } from '../unit/runner/runner-examples.ts';
import {
  CDP_TARGET, FIXTURE_FOLDER, SERVER_ASSETS, click, navigate, networkHarness, role, startStub, stopStub, testId, textEquals, timesRequested,
  type NetworkHarness, type NetworkRun,
} from './network-stubs-support.ts';

const BLOCKED_ORIGIN = 'http://blocked.invalid';

let harness: NetworkHarness;
let resolver: FakeResolver;
let proxy: EgressProxy;

before(async () => {
  harness = await networkHarness({ extraOrigins: [BLOCKED_ORIGIN] });
  // No name is ever resolved: the fixture origins are IP literals and blocked.invalid is undeclared.
  resolver = fakeResolver({});
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: [harness.origin, harness.otherOrigin], allowServices: ['fixture-app', 'other-fixture-app'] }),
    // The fixture app listens on loopback, so it is declared as a private service.
    services: [declaredService('fixture-app', harness.origin, true), declaredService('other-fixture-app', harness.otherOrigin, true)],
    resolve: resolver.resolve,
  });
});
after(async () => {
  await proxy?.close();
  await harness?.close();
});

// Wraps the own driver so each session keeps its browser's request records as it closes.
function keepingRecords(inner: OwnBrowserDriver, keep: (records: readonly BrowserRequestRecord[]) => void): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const close = async (): Promise<void> => {
          try { keep(session.egressRecords()); } finally { await session.close(); }
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

type ProxiedRun = NetworkRun & { readonly egressEvents: readonly EgressEvent[] };

// Runs the steps through the proxy and gives the run's egress events, from this run's records and
// this run's proxy decisions only.
async function runThroughProxy(steps: readonly unknown[]): Promise<ProxiedRun> {
  const records: BrowserRequestRecord[] = [];
  const driver = cdpDriver({ executablePath: BROWSERS.chrome, fixturesFolder: FIXTURE_FOLDER, proxy: { server: proxy.url, includeLoopback: true } });
  const drivers = new Map<string, BrowserDriver>([['cdp', keepingRecords(driver, (kept) => { records.push(...kept); })]]);
  const firstDecision = proxy.decisions().length;
  const ran = await harness.runSteps(CDP_TARGET, steps, { drivers });
  return { ...ran, egressEvents: joinEgressEvents(records, proxy.decisions().slice(firstDecision)) };
}

// The run's events for one origin, matched by host and port, as the proxy and the browser both see it.
const eventsFor = (ran: ProxiedRun, origin: string): readonly EgressEvent[] => {
  const url = new URL(origin);
  const wanted = `${url.hostname}:${url.port === '' ? '80' : url.port}`;
  return ran.egressEvents.filter((event) => hostAndPort(event.origin) === wanted);
};
const fixtureEvents = (ran: ProxiedRun): readonly EgressEvent[] => eventsFor(ran, harness.origin);

const egressSteps = (withStub: boolean): unknown[] => [
  navigate('/egress.html'),
  ...(withStub ? [startStub('stubbedData')] : []),
  click(role('button', 'Fetch stubbed data')),
  textEquals(testId('stubbed-count'), '1', 'egress.first-answer'),
  click(role('button', 'Fetch stubbed data')),
  textEquals(testId('stubbed-count'), '2', 'egress.second-answer'),
  click(role('button', 'Fetch stubbed data')),
  textEquals(testId('stubbed-count'), '3', 'egress.third-answer'),
  textEquals(testId('stubbed-source'), withStub ? 'stub' : 'server', 'egress.who-answered'),
  ...(withStub ? [stopStub('stubbedData')] : []),
  click(role('button', 'Fetch real data')),
  textEquals(testId('real-source'), 'server', 'egress.real-answer'),
  click(role('button', 'Fetch outside data')),
  textEquals(testId('outside-state'), 'Outside tried', 'egress.outside-tried'),
];

test('stubbed requests make no egress event; the fixture origin\'s events are exactly the requests the server received, all allowed', { criterion: 'AC-SPEC-33-05', timeout: 120_000 }, async () => {
  const ran = await runThroughProxy(egressSteps(true));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.equal(timesRequested(ran.requestedPaths, '/api/stubbed-data'), 0, 'the stub answered all three');
  assert.equal(timesRequested(ran.requestedPaths, '/api/real-data'), 1);
  const events = fixtureEvents(ran);
  assert.deepEqual(events.filter((event) => event.decision !== 'allowed'), [], `no fixture-origin event is blocked or unattributed: ${JSON.stringify(ran.egressEvents)}`);
  assert.equal(events.length, ran.requestedPaths.length, `one allowed event per request the server received: ${JSON.stringify(ran.requestedPaths)}`);
});

test('unstubbed requests still go through the egress proxy: the fixture origin\'s are allowed and blocked.invalid is blocked by the proxy', { criterion: 'AC-SPEC-33-05', timeout: 120_000 }, async () => {
  const firstDecision = proxy.decisions().length;
  const ran = await runThroughProxy(egressSteps(true));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  const decided = proxy.decisions().slice(firstDecision);
  const blockedHost = hostOf(BLOCKED_ORIGIN);
  assert.ok(decided.some((entry) => hostOf(String(entry.origin)) === blockedHost && entry.decision === 'blocked'), `the proxy itself blocked blocked.invalid: ${JSON.stringify(decided)}`);
  assert.deepEqual(decided.filter((entry) => hostOf(String(entry.origin)) === blockedHost && entry.decision === 'allowed'), []);
  assert.ok(eventsFor(ran, BLOCKED_ORIGIN).some((event) => event.decision === 'blocked'), JSON.stringify(ran.egressEvents));
  assert.ok(!resolver.asked.includes(blockedHost), 'the undeclared name was never looked up');
  assert.ok(fixtureEvents(ran).some((event) => event.decision === 'allowed'), 'the real-data request was allowed');
});

// Counter-example: without the stub, the same three requests reach the server through the proxy,
// and each is one more allowed event.
test('counter-example: without the stub, the same three requests reach the server and add three allowed events', { criterion: 'AC-SPEC-33-05', timeout: 120_000 }, async () => {
  const stubbed = await runThroughProxy(egressSteps(true));
  const unstubbed = await runThroughProxy(egressSteps(false));
  assert.equal(unstubbed.result.state, 'Passed', JSON.stringify(unstubbed.result.steps));
  assert.equal(timesRequested(unstubbed.requestedPaths, '/api/stubbed-data'), 3);
  const allowed = (ran: ProxiedRun) => fixtureEvents(ran).filter((event) => event.decision === 'allowed').length;
  assert.equal(allowed(unstubbed), allowed(stubbed) + 3, `${JSON.stringify(fixtureEvents(stubbed))} against ${JSON.stringify(fixtureEvents(unstubbed))}`);
});

test('a script, style sheet, frame, worker and image that match a stub go through the egress proxy to the server', { criterion: 'AC-SPEC-33-03', timeout: 120_000 }, async () => {
  const ran = await runThroughProxy([
    navigate('/resources.html'),
    startStub('assetRequests'),
    click(role('button', 'Load every resource')),
    textEquals(testId('script-state'), 'Script from server', 'proxy.script'),
    textEquals(testId('style-state'), 'Style from server', 'proxy.style'),
    textEquals(testId('frame-state'), 'Frame from server', 'proxy.frame'),
    textEquals(testId('worker-state'), 'Worker from server', 'proxy.worker'),
    textEquals(testId('image-state'), 'Image from server', 'proxy.image'),
    textEquals(testId('fetch-state'), 'Fetch: stub answered', 'proxy.fetch-stubbed'),
    navigate('/api/assets/page.html'),
    textEquals(testId('document-source'), 'Document from server', 'proxy.document'),
    stopStub('assetRequests'),
  ]);
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  for (const path of Object.keys(SERVER_ASSETS)) assert.equal(timesRequested(ran.requestedPaths, path), 1, `${path} reached the server`);
  const events = fixtureEvents(ran);
  assert.deepEqual(events.filter((event) => event.decision !== 'allowed'), [], JSON.stringify(ran.egressEvents));
  assert.equal(events.length, ran.requestedPaths.length, 'every request the server received went through the proxy, and nothing else was recorded');
});
