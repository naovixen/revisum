// Turns what the browser saw and what the egress proxy decided into a run's egress events. Over
// HTTPS and for WebSockets the proxy sees only a host and port, so the channel comes from the
// browser.
import {
    EgressChannel,
    BrowserChannel,
    hostAndPort,
    type BrowserRequestRecord,
    type EgressDecision,
    type EgressEvent,
    type ProxyDecision,
    type SeenOrigin,
} from "@revisum/contracts";

// True for an origin whose traffic the proxy can read, and so the only kind a rewrite may change.
export const isPlainHttpOrigin = (origin: SeenOrigin): boolean => origin.startsWith("http://");

// Pairs each proxy decision with the browser's next unpaired record for the same host and port, in
// the order both happened. A decision with no such record is `unattributed`: its channel is never
// guessed. A popup never pairs, because the driver holds it back before it loads, so any decision
// for its origin belongs to another request.
//
// A record left with no decision of its own is, in this order:
//   - if its channel is popup, for the reason above, `blocked` when its origin is undeclared and
//     otherwise `held`, since nothing refused it;
//   - given the latest decision for its host and port, since one tunnel carries many requests;
//   - `allowed` if its host and port are in `directOrigins`, which the run knows the browser sends
//     past the proxy, such as its own loopback;
//   - otherwise `blocked`. That can over-report a block, but never claims an unseen request was allowed.
//
// Events follow the decisions' order; the records left over come last, in their own order.
export function joinEgressEvents(
    records: readonly BrowserRequestRecord[],
    decisions: readonly ProxyDecision[],
    directOrigins: readonly SeenOrigin[] = [],
): readonly EgressEvent[] {
    const waiting = new Map<string, BrowserRequestRecord[]>();
    for (const record of records) {
        if (record.channel === BrowserChannel.Popup) {
            continue;
        }
        const key = hostAndPort(record.origin);
        waiting.set(key, [...(waiting.get(key) ?? []), record]);
    }
    const latest = new Map<string, EgressDecision>(
        decisions.map((decided) => [hostAndPort(decided.origin), decided.decision]),
    );
    const direct = new Set(directOrigins.map(hostAndPort));
    const paired = new Set<BrowserRequestRecord>();
    const events: EgressEvent[] = decisions.map((decided) => {
        const record = waiting.get(hostAndPort(decided.origin))?.shift();
        if (record === undefined) {
            return {
                origin: decided.origin,
                channel: EgressChannel.Unattributed,
                decision: decided.decision,
            };
        }
        paired.add(record);
        return { origin: record.origin, channel: record.channel, decision: decided.decision };
    });
    const decisionFor = (record: BrowserRequestRecord): EgressDecision => {
        if (record.channel === BrowserChannel.Popup) {
            return record.undeclared === true ? "blocked" : "held";
        }
        const key = hostAndPort(record.origin);
        return latest.get(key) ?? (direct.has(key) ? "allowed" : "blocked");
    };
    for (const record of records) {
        if (!paired.has(record)) {
            events.push({
                origin: record.origin,
                channel: record.channel,
                decision: decisionFor(record),
            });
        }
    }
    return events;
}
