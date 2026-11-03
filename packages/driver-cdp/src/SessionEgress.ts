import { failure, hostAndPort, success, type Brand, type Result } from "@revisum/contracts";
import { errorText } from "./browser-session.ts";
import { LOOPBACK_THROUGH_PROXY, type ProxySettings } from "./chrome-flags.ts";

// A declared origin the egress could not connect to, with what to tell whoever is running.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

// One browser session's way out of the machine.
export type SessionEgress = {
    // What the source says. The driver parses it before any browser context uses it.
    readonly proxy: ProxySettings;
    // What the egress refused, in its own form, such as "host:443".
    refusedOrigins(): readonly string[];
    // A diagnostic for whoever is running, which stays out of the hashed result.
    connectionFailures?(): readonly ConnectionFailure[];
    close(): Promise<void>;
};

// Starts a session's egress. The allow-list first exists when a session opens, so the source is asked
// then. The driver may not import the runner, so whoever builds the driver hands this in.
export type EgressSource = (allowedOrigins: readonly string[]) => Promise<SessionEgress>;

type ProxyServer = Brand<string, "ProxyServer">;

// An empty proxyServer creates a browser context without error, and everything in it then goes
// direct, even with a browser-wide proxy up. So nothing else may reach a context's proxy.
function parseProxyServer(server: string): Result<ProxyServer, string> {
    if (server.trim() === "") {
        return failure("the session's egress named no proxy server");
    }
    return success(server as ProxyServer);
}

// Target.createBrowserContext's own parameter names.
export type BrowserContextProxy = {
    readonly proxyServer: ProxyServer;
    readonly proxyBypassList?: string;
};

export type OpenedSessionEgress = {
    readonly egress: SessionEgress;
    readonly contextProxy: BrowserContextProxy;
};

// The session's egress, started and with its proxy parsed, or why not. A proxy that fails the parse
// was started all the same, so it is closed here.
export async function openSessionEgress(
    source: EgressSource,
    allowedOrigins: readonly string[],
): Promise<Result<OpenedSessionEgress, string>> {
    try {
        const egress = await source(allowedOrigins);
        const proxyServer = parseProxyServer(egress.proxy.server);
        if (!proxyServer.ok) {
            await egress.close();
            return proxyServer;
        }
        return success({
            egress,
            contextProxy: {
                proxyServer: proxyServer.value,
                ...(egress.proxy.includeLoopback
                    ? { proxyBypassList: LOOPBACK_THROUGH_PROXY }
                    : {}),
            },
        });
    } catch (error) {
        return failure(errorText(error));
    }
}

// The one list of what was refused, so "https://x" and "x:443" can't both appear. The browser's form
// says more, so it wins.
export function mergeRefusedOrigins(
    seenByBrowser: readonly string[],
    refusedByEgress: readonly string[],
): readonly string[] {
    const inBrowserForm = new Set(seenByBrowser.map(hostAndPort));
    const onlyEgressSaw = new Map(
        refusedByEgress
            .filter((origin) => !inBrowserForm.has(hostAndPort(origin)))
            .map((origin) => [hostAndPort(origin), origin]),
    );
    return [...seenByBrowser, ...onlyEgressSaw.values()];
}
