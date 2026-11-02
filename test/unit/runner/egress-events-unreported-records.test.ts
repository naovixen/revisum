// What a browser record with no proxy decision of its own becomes, in the order the spec gives:
//   1. blocked if its channel is popup, because the driver holds a popup back before it loads;
//   2. otherwise the latest decision for the same host and port, because one tunnel carries many
//      requests;
//   3. otherwise allowed if its origin is one the run knows the browser sends past the proxy;
//   4. otherwise blocked, which can over-report a block but never claims an unseen request was
//      allowed.
// Each rule has a neighbouring case the next rule would decide differently, so a join that skipped
// or reordered a rule fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserChannel, EgressEvent } from '@revisum/contracts';
import { joinEgressEvents } from '@revisum/runner';
import { origin } from './runner-examples.ts';

const APP = origin('http://app.test');
const ELSEWHERE = origin('http://elsewhere.test');
const LOOPBACK = origin('http://127.0.0.1:4310');
const LOOPBACK_OTHER_PORT = origin('http://127.0.0.1:4311');

const record = (seen: string, channel: BrowserChannel) => ({ origin: seen, channel });
const allowed = (seen: string) => ({ origin: seen, decision: 'allowed' as const });
const blocked = (seen: string) => ({ origin: seen, decision: 'blocked' as const });

const decisionsOn = (events: readonly EgressEvent[], channel: BrowserChannel): readonly string[] =>
  events.filter((event) => event.channel === channel).map((event) => event.decision);

// ---- A popup ------------------------------------------------------------------------------------

test('a popup is blocked even though the proxy allowed its origin for the page\'s own request', () => {
  const events = joinEgressEvents([record(APP, 'page'), record(APP, 'popup')], [allowed(APP)]);
  assert.deepEqual(decisionsOn(events, 'popup'), ['blocked']);
  assert.deepEqual(decisionsOn(events, 'page'), ['allowed']);
});

test('a popup recorded before the page\'s own request does not take that request\'s allowed decision', () => {
  const events = joinEgressEvents([record(APP, 'popup'), record(APP, 'page')], [allowed(APP)]);
  assert.deepEqual(decisionsOn(events, 'popup'), ['blocked']);
  assert.deepEqual(decisionsOn(events, 'page'), ['allowed']);
});

test('a popup is blocked when an allowed decision for its origin is the only decision there is', () => {
  const events = joinEgressEvents([record(APP, 'popup')], [allowed(APP)]);
  assert.deepEqual(decisionsOn(events, 'popup'), ['blocked']);
});

test('a popup is blocked even when its origin is one the browser sends past the proxy', () => {
  const events = joinEgressEvents([record(LOOPBACK, 'popup')], [], [LOOPBACK]);
  assert.deepEqual(events, [{ origin: LOOPBACK, channel: 'popup', decision: 'blocked' }]);
});

// ---- The latest decision for the same host and port -------------------------------------------------

test('requests sharing one tunnel all take that tunnel\'s decision', () => {
  const events = joinEgressEvents(
    [record('https://app.test', 'page'), record('https://app.test', 'worker'), record('https://app.test', 'beacon')],
    [allowed('app.test:443')],
  );
  assert.deepEqual(events, [
    { origin: 'https://app.test', channel: 'page', decision: 'allowed' },
    { origin: 'https://app.test', channel: 'worker', decision: 'allowed' },
    { origin: 'https://app.test', channel: 'beacon', decision: 'allowed' },
  ]);
});

test('a record with no decision of its own takes the latest decision for its host and port, not the first', () => {
  const allowedLast = joinEgressEvents(
    [record(APP, 'page'), record(APP, 'worker'), record(APP, 'beacon')],
    [blocked(APP), allowed(APP)],
  );
  assert.deepEqual(decisionsOn(allowedLast, 'beacon'), ['allowed']);
  const blockedLast = joinEgressEvents(
    [record(APP, 'page'), record(APP, 'worker'), record(APP, 'beacon')],
    [allowed(APP), blocked(APP)],
  );
  assert.deepEqual(decisionsOn(blockedLast, 'beacon'), ['blocked']);
});

test('a WebSocket and a page request to one host and port share a decision whatever their schemes', () => {
  const events = joinEgressEvents([record('ws://socket.test', 'websocket'), record('http://socket.test', 'page')], [allowed('socket.test:80')]);
  assert.deepEqual(decisionsOn(events, 'websocket'), ['allowed']);
  assert.deepEqual(decisionsOn(events, 'page'), ['allowed']);
});

test('counter-example: a decision for another port of the same host is not taken', () => {
  const events = joinEgressEvents([record('http://socket.test:8080', 'page')], [allowed('socket.test:80')]);
  assert.deepEqual(decisionsOn(events, 'page'), ['blocked']);
});

test('counter-example: a decision for another host is not taken', () => {
  const events = joinEgressEvents([record(ELSEWHERE, 'page')], [allowed(APP)]);
  assert.deepEqual(decisionsOn(events, 'page'), ['blocked']);
});

test('a decision for the host and port outranks its origin being sent past the proxy', () => {
  const events = joinEgressEvents([record(LOOPBACK, 'page'), record(LOOPBACK, 'worker')], [blocked(LOOPBACK)], [LOOPBACK]);
  assert.deepEqual(decisionsOn(events, 'page'), ['blocked']);
  assert.deepEqual(decisionsOn(events, 'worker'), ['blocked']);
});

// ---- Origins the browser sends past the proxy ----------------------------------------------------------

test('a record with no decision is allowed when its origin is one the browser sends past the proxy', () => {
  const events = joinEgressEvents([record(LOOPBACK, 'page')], [], [LOOPBACK]);
  assert.deepEqual(events, [{ origin: LOOPBACK, channel: 'page', decision: 'allowed' }]);
});

// ---- The fallback -----------------------------------------------------------------------------------------

test('a record with no decision and an origin not in directOrigins is blocked, never assumed allowed', () => {
  const events = joinEgressEvents([record(ELSEWHERE, 'page')], [], [LOOPBACK]);
  assert.deepEqual(events, [{ origin: ELSEWHERE, channel: 'page', decision: 'blocked' }]);
});

test('another port of a direct origin\'s host is not itself direct', () => {
  const events = joinEgressEvents([record(LOOPBACK_OTHER_PORT, 'page')], [], [LOOPBACK]);
  assert.deepEqual(decisionsOn(events, 'page'), ['blocked']);
});

test('with no direct origins given, a record with no decision is blocked', () => {
  assert.deepEqual(decisionsOn(joinEgressEvents([record(LOOPBACK, 'page')], []), 'page'), ['blocked']);
});

test('a decision the browser never reported stays unattributed, even for a direct origin', () => {
  const events = joinEgressEvents([], [allowed(LOOPBACK)], [LOOPBACK]);
  assert.deepEqual(events, [{ origin: LOOPBACK, channel: 'unattributed', decision: 'allowed' }]);
});
