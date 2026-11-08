import { EgressDecision, type AppliedRewrite, type ProxyDecision } from "@revisum/contracts";
import type { ProxyClient } from "./ProxyClient.ts";

// A declared origin the proxy allowed but could not connect to.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

// A socket listener's failure after it started listening, such as a failed accept, or a throw from
// one of the record's listeners.
export type ListenerFailure = { readonly message: string };

// Each may throw: the throw is kept as a listener failure, and the proxy goes on.
export type ProxyRecordListeners = {
    // Called with each decision as it is made, such as to write it where the runner can read it, and
    // who it was made for.
    readonly onDecision?: (decision: ProxyDecision, client: ProxyClient) => void;
    // Called once per origin and mutant, the first time a rewrite changes a response.
    readonly onRewriteApplied?: (applied: AppliedRewrite) => void;
    // Called with each listener failure, for a process that nothing reads the record of.
    readonly onListenerFailure?: (failure: ListenerFailure) => void;
};

const NOT_AN_ERROR = "a listener of the proxy's record threw something that is not an Error";

// Everything one proxy has decided and noted.
export type ProxyRecord = {
    readonly noteDecision: (
        origin: string,
        decision: ProxyDecision["decision"],
        client: ProxyClient,
    ) => void;
    // Only an origin's first failure is kept.
    readonly noteConnectionFailure: (origin: string, message: string) => void;
    // Only the first of each origin and rewrite name is kept.
    readonly noteRewriteApplied: (origin: string, rewriteName: string) => void;
    readonly noteListenerFailure: (message: string) => void;
    readonly decisions: () => readonly ProxyDecision[];
    readonly refusedOrigins: () => readonly string[];
    readonly rewritesApplied: () => readonly AppliedRewrite[];
    readonly connectionFailures: () => readonly ConnectionFailure[];
    readonly listenerFailures: () => readonly ListenerFailure[];
};

export function createProxyRecord(listeners: ProxyRecordListeners): ProxyRecord {
    const decided: ProxyDecision[] = [];
    const applied = new Map<string, AppliedRewrite>();
    const failures = new Map<string, ConnectionFailure>();
    const listenerFailures: ListenerFailure[] = [];
    // The proxy calls these from its request handlers, where a throw would end the process.
    const callContained = (callListener: () => void): void => {
        try {
            callListener();
        } catch (thrown) {
            listenerFailures.push({
                message: thrown instanceof Error ? thrown.message : NOT_AN_ERROR,
            });
        }
    };
    return {
        noteDecision: (origin, decision, client) => {
            const entry: ProxyDecision = { origin, decision };
            decided.push(entry);
            callContained(() => listeners.onDecision?.(entry, client));
        },
        noteConnectionFailure: (origin, message) => {
            if (!failures.has(origin)) {
                failures.set(origin, { origin, message });
            }
        },
        noteRewriteApplied: (origin, rewriteName) => {
            const key = `${origin}\n${rewriteName}`;
            if (applied.has(key)) {
                return;
            }
            const entry: AppliedRewrite = { origin, name: rewriteName };
            applied.set(key, entry);
            callContained(() => listeners.onRewriteApplied?.(entry));
        },
        noteListenerFailure: (message) => {
            const entry: ListenerFailure = { message };
            listenerFailures.push(entry);
            callContained(() => listeners.onListenerFailure?.(entry));
        },
        decisions: () => [...decided],
        refusedOrigins: () =>
            decided
                .filter((entry) => entry.decision === EgressDecision.Blocked)
                .map((entry) => entry.origin),
        rewritesApplied: () => [...applied.values()],
        connectionFailures: () => [...failures.values()],
        listenerFailures: () => [...listenerFailures],
    };
}
