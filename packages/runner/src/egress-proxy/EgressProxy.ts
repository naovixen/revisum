// The egress proxy: the one way out of a run. It lets a request through only to a declared origin
// or service, resolves the name itself, and refuses it when any address the name resolves to is
// link-local or a metadata service, private or loopback (unless the service is declared private), or
// when the name's address class differs from its first accepted lookup in this run. It connects only
// to addresses it checked, each in turn, with no second lookup, so DNS rebinding cannot swap an
// address in between. Every decision is recorded. A name that doesn't resolve and an origin nobody
// listens on weren't refused, so they count as allowed and are noted as failures.
//
// Plain HTTP arrives as an absolute-form request and is forwarded; HTTPS and WebSockets arrive as
// CONNECT tunnels, of which the proxy sees only the host and port. On a declared fixture origin it
// can apply a browser mutant's rewrite to a plain-HTTP response body.
//
// For a database command it also relays plain TCP: one port per service the policy allows over
// TCP, the service's own declared port, to that service's address and nothing else. Each
// connection is vetted like a request (resolved by the proxy, metadata addresses refused) and
// recorded as a decision on "host:port".
// It runs in-process for tests and, in a run, in its own container (proxy-container.ts).
import type { AppliedRewrite, ProxyDecision } from "@revisum/contracts";
import type { ConnectionFailure } from "./ProxyRecord.ts";

export type EgressProxy = {
    // The proxy's address, such as "http://127.0.0.1:41234", for --proxy-server or HTTP_PROXY.
    readonly url: string;
    // Every decision so far, in the order made.
    decisions(): readonly ProxyDecision[];
    // Each rewrite applied so far, once per origin and mutant.
    rewritesApplied(): readonly AppliedRewrite[];
    // Each origin it could not connect to so far, once per origin, with what to tell whoever is running.
    connectionFailures(): readonly ConnectionFailure[];
    close(): Promise<void>;
};
