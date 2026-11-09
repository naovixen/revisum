import {
    EgressDecision,
    EgressChannel,
    hostAndPort,
    type EgressEvent,
    type EgressPolicy,
    type ProxyDecision,
} from "@revisum/contracts";

// The host part of an origin the proxy decided on, so a lookup of the same name is not counted twice.
function decidedHost(origin: string): string {
    const hostPort = hostAndPort(origin);
    const bracketed = /^\[([^\]]+)\]/.exec(hostPort);
    if (bracketed !== null) {
        return (bracketed[1] ?? "").toLowerCase();
    }
    return (hostPort.split(":")[0] ?? "").toLowerCase();
}

// The lookups no proxy decision accounts for and no declared origin explains, once per name, as
// blocked attempts of a process that ignored the proxy.
export function processEvents(
    lookups: readonly string[],
    decisions: readonly ProxyDecision[],
    policy: EgressPolicy,
): readonly EgressEvent[] {
    const explained = new Set([
        ...decisions.map((decision) => decidedHost(decision.origin)),
        ...policy.allowOrigins.map((origin) => decidedHost(origin)),
    ]);
    return [...new Set(lookups)]
        .filter((name) => !explained.has(name))
        .map((name): EgressEvent => ({
            origin: name,
            channel: EgressChannel.Process,
            decision: EgressDecision.Blocked,
        }));
}
