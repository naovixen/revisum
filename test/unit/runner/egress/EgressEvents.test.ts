// How a run turns what the browser saw and what the proxy decided into egress events. Over HTTPS
// the proxy sees only a host and port, so the channel (page, WebSocket, worker, popup, redirect or
// beacon) comes from the browser's records. The two are joined by origin, in order; a decision the
// browser never reported is marked unattributed, never given a guessed channel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinEgressEvents } from '@revisum/runner';
import { origin } from '../examples/DeclaredService.ts';
import { BrowserChannel } from '@revisum/contracts';

const SOCKET = origin('http://socket.invalid');
const BEACON = origin('http://beacon.invalid');
const APP = origin('http://app.test');

test('each proxy decision takes the channel of the browser record for the same origin', () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: BrowserChannel.Page }, { origin: SOCKET, channel: BrowserChannel.Websocket }, { origin: BEACON, channel: BrowserChannel.Beacon }],
    [{ origin: APP, decision: 'allowed' }, { origin: SOCKET, decision: 'blocked' }, { origin: BEACON, decision: 'blocked' }],
  );
  assert.deepEqual(events, [
    { origin: APP, channel: 'page', decision: 'allowed' },
    { origin: SOCKET, channel: 'websocket', decision: 'blocked' },
    { origin: BEACON, channel: 'beacon', decision: 'blocked' },
  ]);
});

test('records and decisions for one origin are paired in the order they happened', () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: BrowserChannel.Page }, { origin: APP, channel: BrowserChannel.Worker }, { origin: APP, channel: BrowserChannel.Redirect }],
    [{ origin: APP, decision: 'allowed' }, { origin: APP, decision: 'allowed' }, { origin: APP, decision: 'blocked' }],
  );
  assert.deepEqual(events.map((event) => [event.channel, event.decision]), [['page', 'allowed'], ['worker', 'allowed'], ['redirect', 'blocked']]);
});

test('a decision the browser never reported is unattributed, not given another origin\'s channel', () => {
  const events = joinEgressEvents(
    [{ origin: APP, channel: BrowserChannel.Websocket }],
    [{ origin: SOCKET, decision: 'blocked' }, { origin: APP, decision: 'blocked' }],
  );
  assert.deepEqual(events, [
    { origin: SOCKET, channel: 'unattributed', decision: 'blocked' },
    { origin: APP, channel: 'websocket', decision: 'blocked' },
  ]);
});

test('a second decision for an origin the browser reported once is unattributed', () => {
  const events = joinEgressEvents(
    [{ origin: BEACON, channel: BrowserChannel.Beacon }],
    [{ origin: BEACON, decision: 'blocked' }, { origin: BEACON, decision: 'blocked' }],
  );
  assert.deepEqual(events.map((event) => event.channel), ['beacon', 'unattributed']);
});
