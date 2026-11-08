import type { AppliedRewrite, ProxyDecision } from "@revisum/contracts";
import type { ProxyClient } from "./ProxyClient.ts";

// A declared origin the proxy allowed but could not connect to.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

export type ProxyRecordListeners = {
    // Called with each decision as it is made, such as to write it where the runner can read it, and
    // who it was made for.
    readonly onDecision?: (decision: ProxyDecision, client: ProxyClient) => void;
    // Called once per origin and mutant, the first time a rewrite changes a response.
    readonly onRewriteApplied?: (applied: AppliedRewrite) => void;
};

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
    readonly decisions: () => readonly ProxyDecision[];
    readonly rewritesApplied: () => readonly AppliedRewrite[];
    readonly connectionFailures: () => readonly ConnectionFailure[];
};

export function createProxyRecord(listeners: ProxyRecordListeners): ProxyRecord {
    const decided: ProxyDecision[] = [];
    const applied = new Map<string, AppliedRewrite>();
    const failures = new Map<string, ConnectionFailure>();
    return {
        noteDecision: (origin, decision, client) => {
            const entry: ProxyDecision = { origin, decision };
            decided.push(entry);
            listeners.onDecision?.(entry, client);
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
            listeners.onRewriteApplied?.(entry);
        },
        decisions: () => [...decided],
        rewritesApplied: () => [...applied.values()],
        connectionFailures: () => [...failures.values()],
    };
}
