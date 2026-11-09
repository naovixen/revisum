// What browser tests give a driver for its sessions' egress. What they assume about a session's egress
// is gathered here, so a change to it is a change to this file.
import { failure, success, type Result } from "@revisum/contracts";
import type { ConnectionFailure } from "@revisum/driver-cdp";
import { ProxyClient, type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";

export type SessionEgressForTest = {
    readonly proxy: { readonly server: string; readonly includeLoopback: boolean };
    refusedOrigins(): Result<readonly string[], string>;
    connectionFailures(): readonly ConnectionFailure[];
    close(): Promise<Result<void, string>>;
};

export type EgressSourceForTest = (
    allowedOrigins: readonly string[],
) => Promise<Result<SessionEgressForTest, string>>;

// A source's answer with the egress it started changed, or why it did not start, as it is.
export const withStartedEgress = (
    started: Result<SessionEgressForTest, string>,
    change: (egress: SessionEgressForTest) => SessionEgressForTest,
): Result<SessionEgressForTest, string> => (started.ok ? success(change(started.value)) : started);

const refusedSince = (proxy: EgressProxy, firstDecision: number): readonly string[] =>
    proxy
        .decisions()
        .slice(firstDecision)
        .filter((entry) => entry.decision === "blocked")
        .map((entry) => String(entry.origin));

const leavingProxyUp = (
    proxy: EgressProxy,
    firstDecision: number,
): Omit<SessionEgressForTest, "close"> => ({
    proxy: { server: proxy.url, includeLoopback: true },
    refusedOrigins: () => success(refusedSince(proxy, firstDecision)),
    connectionFailures: () => proxy.connectionFailures(),
});

// A session's egress on a real proxy of its own, whose rules are the ones a host run gives it: every
// declared origin may reach a private address, and nothing else is let through.
export const realEgressSource: EgressSourceForTest = async (allowedOrigins) => {
    const proxy = await startedProxyServer(
        { allowedOrigins, privateOrigins: allowedOrigins, rewrites: [] },
        { client: ProxyClient.Browser },
    );
    return success({
        ...leavingProxyUp(proxy, 0),
        close: async () => {
            const closed = await proxy.close();
            return closed.ok ? success(undefined) : failure(closed.error.message);
        },
    });
};

// For a test that shapes or watches a proxy of its own, which outlives each session: a session is told
// only of the refusals made since it opened, and its close leaves the proxy up.
export const egressThrough =
    (proxy: EgressProxy): EgressSourceForTest =>
    () =>
        Promise.resolve(
            success({
                ...leavingProxyUp(proxy, proxy.decisions().length),
                close: () => Promise.resolve(success(undefined)),
            }),
        );
