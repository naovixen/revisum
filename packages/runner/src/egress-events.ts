// Turns what the browser saw and what the egress proxy decided into a run's egress events. Over
// HTTPS and for WebSockets the proxy sees only a host and port, so the channel comes from the
// browser. See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { BrowserRequestRecord, EgressEvent, ProxyDecision, SeenOrigin } from '@revisum/contracts';

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'ws:': '80', 'https:': '443', 'wss:': '443' };

// The host and port an origin reaches, so "ws://socket.test" (as the browser reports a WebSocket)
// meets "socket.test:80" (the tunnel the proxy was asked for).
export function hostAndPort(origin: SeenOrigin): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
    try {
      const url = new URL(origin);
      return `${url.hostname}:${url.port === '' ? DEFAULT_PORTS[url.protocol] ?? '' : url.port}`;
    } catch {
      return origin.toLowerCase();
    }
  }
  return origin.toLowerCase();
}

// Pairs each proxy decision with the browser's next unpaired record for the same host and port, in
// the order both happened.
//   - A decision with no such record is `unattributed`: its channel is never guessed.
//   - A record with no decision never reached the proxy, because the browser itself held it back
//     (its own allow-list, or a popup the driver closed before it loaded), so it is `blocked`.
// Events follow the decisions' order; the unpaired records come last, in their own order.
export function joinEgressEvents(records: readonly BrowserRequestRecord[], decisions: readonly ProxyDecision[]): readonly EgressEvent[] {
  const waiting = new Map<string, BrowserRequestRecord[]>();
  for (const record of records) {
    const key = hostAndPort(record.origin);
    waiting.set(key, [...(waiting.get(key) ?? []), record]);
  }
  const events: EgressEvent[] = decisions.map((decided) => {
    const record = waiting.get(hostAndPort(decided.origin))?.shift();
    return record === undefined
      ? { origin: decided.origin, channel: 'unattributed', decision: decided.decision }
      : { origin: record.origin, channel: record.channel, decision: decided.decision };
  });
  const unpaired = new Set([...waiting.values()].flat());
  for (const record of records) {
    if (unpaired.has(record)) events.push({ origin: record.origin, channel: record.channel, decision: 'blocked' });
  }
  return events;
}
