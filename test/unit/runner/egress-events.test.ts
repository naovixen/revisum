// How a run turns what the browser saw and what the proxy decided into egress events. Over HTTPS
// the proxy sees only a host and port, so the channel (page, WebSocket, worker, popup, redirect or
// beacon) comes from the browser's records. The two are joined by origin, in order; a decision the
// browser never reported is marked unattributed, never given a guessed channel.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinEgressEvents } from '@revisum/runner';
import { origin } from './runner-examples.ts';

const SOCKET = origin('http://socket.invalid');
const BEACON = origin('http://beacon.invalid');
const APP = origin('http://app.test');

test('each proxy decision takes the channel of the browser record for the same origin', { criterion: 'AC-SPEC-07-01' }, () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: 'page' }, { origin: SOCKET, channel: 'websocket' }, { origin: BEACON, channel: 'beacon' }],
    [{ origin: APP, decision: 'allowed' }, { origin: SOCKET, decision: 'blocked' }, { origin: BEACON, decision: 'blocked' }],
  );
  assert.deepEqual(events, [
    { origin: APP, channel: 'page', decision: 'allowed' },
    { origin: SOCKET, channel: 'websocket', decision: 'blocked' },
    { origin: BEACON, channel: 'beacon', decision: 'blocked' },
  ]);
});

test('records and decisions for one origin are paired in the order they happened', { criterion: 'AC-SPEC-07-01' }, () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: 'page' }, { origin: APP, channel: 'worker' }, { origin: APP, channel: 'redirect' }],
    [{ origin: APP, decision: 'allowed' }, { origin: APP, decision: 'allowed' }, { origin: APP, decision: 'blocked' }],
  );
  assert.deepEqual(events.map((event) => [event.channel, event.decision]), [['page', 'allowed'], ['worker', 'allowed'], ['redirect', 'blocked']]);
});

test('a decision the browser never reported is unattributed, not given another origin\'s channel', { criterion: 'AC-SPEC-07-01' }, () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: 'websocket' }],
    [{ origin: SOCKET, decision: 'blocked' }, { origin: APP, decision: 'blocked' }],
  );
  assert.deepEqual(events, [
    { origin: SOCKET, channel: 'unattributed', decision: 'blocked' },
    { origin: APP, channel: 'websocket', decision: 'blocked' },
  ]);
});

test('a second decision for an origin the browser reported once is unattributed', { criterion: 'AC-SPEC-07-01' }, () => {
  const events = joinEgressEvents(
    [{ origin: BEACON, channel: 'beacon' }],
    [{ origin: BEACON, decision: 'blocked' }, { origin: BEACON, decision: 'blocked' }],
  );
  assert.deepEqual(events.map((event) => event.channel), ['beacon', 'unattributed']);
});
