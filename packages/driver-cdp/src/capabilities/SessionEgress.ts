import { failure, success, type Brand, type Result } from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";
import { LOOPBACK_THROUGH_PROXY, type ProxySettings } from "../launch/SessionEgressChromeFlags.ts";

// A declared origin the egress could not connect to, with what to tell whoever is running.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

// One browser session's way out of the machine.
export type SessionEgress = {
    // What the source says. The driver parses it before any browser context uses it.
    readonly proxy: ProxySettings;
    // What the egress refused, in its own form, such as "host:443". Throws when that can't be known.
    refusedOrigins(): readonly string[];
    // A diagnostic for whoever is running, which stays out of the hashed result.
    connectionFailures(): readonly ConnectionFailure[];
    close(): Promise<void>;
};

// Starts a session's egress. The allow-list first exists when a session opens, so the source is asked
// then. The driver may not import the runner, so whoever builds the driver hands this in.
export type EgressSource = (allowedOrigins: readonly string[]) => Promise<SessionEgress>;

// Everything a proxy has refused so far, oldest first, in its own form, or why that can't be read.
export type RefusalReader = () => Promise<Result<readonly string[], string>>;

const NO_REFUSALS_TO_READ: RefusalReader = () => Promise.resolve(success([]));

// For a proxy that something else runs, such as an isolated run's, in a container of its own. That
// proxy holds the allow-list and the record of what it refused, so all this session has to report is
// what was added between its open and its close, which is when the browser has stopped asking. A
// proxy that can't say at open has its whole list counted, which over-reports rather than hides. A
// failed read is left for refusedOrigins to say, since a session with no need of the list still
// closes. The proxy can't reach this machine's loopback, so loopback stays out of it.
export const egressThroughExistingProxy =
    (server: string, readRefusals: RefusalReader = NO_REFUSALS_TO_READ): EgressSource =>
    async () => {
        const atOpen = await readRefusals();
        const refusedBeforeOpening = atOpen.ok ? atOpen.value.length : 0;
        let sinceOpening: Result<readonly string[], string> = success([]);
        return {
            proxy: { server, includeLoopback: false },
            refusedOrigins: () => {
                if (!sinceOpening.ok) {
                    throw new Error(sinceOpening.error);
                }
                return sinceOpening.value;
            },
            connectionFailures: () => [],
            close: async () => {
                const atClose = await readRefusals();
                sinceOpening = atClose.ok
                    ? success(atClose.value.slice(refusedBeforeOpening))
                    : atClose;
            },
        };
    };

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
