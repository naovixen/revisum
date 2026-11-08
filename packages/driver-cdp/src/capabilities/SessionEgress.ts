import { failure, success, type Brand, type Result } from "@revisum/contracts";
import { LOOPBACK_THROUGH_PROXY, type ProxySettings } from "../launch/SessionEgressChromeFlags.ts";

// A declared origin the egress could not connect to, with what to tell whoever is running.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

// One browser session's way out of the machine.
export type SessionEgress = {
    // What the source says. The driver parses it before any browser context uses it.
    readonly proxy: ProxySettings;
    // What the egress refused, in its own form, such as "host:443", or why that can't be known.
    refusedOrigins(): Result<readonly string[], string>;
    // A diagnostic for whoever is running, which stays out of the hashed result. It also holds any
    // failure of the egress itself while it ran, named after the egress rather than an origin.
    connectionFailures(): readonly ConnectionFailure[];
    // Says whether the egress closed, and if not, why. It never rejects for that.
    close(): Promise<Result<void, string>>;
};

// Starts a session's egress. The allow-list first exists when a session opens, so the source is asked
// then. The driver may not import the runner, so whoever builds the driver hands this in. A source
// says in its answer that it could not start, and why, and leaves nothing running when it does.
export type EgressSource = (
    allowedOrigins: readonly string[],
) => Promise<Result<SessionEgress, string>>;

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
        return success({
            proxy: { server, includeLoopback: false },
            refusedOrigins: () => sinceOpening,
            connectionFailures: () => [],
            close: async () => {
                const atClose = await readRefusals();
                sinceOpening = atClose.ok
                    ? success(atClose.value.slice(refusedBeforeOpening))
                    : atClose;
                return success(undefined);
            },
        });
    };

export type ProxyServer = Brand<string, "ProxyServer">;

// A host name, a container's name or a bracketed IPv6 address, then a port of up to five digits.
const PROXY_ADDRESS = /^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):([0-9]{1,5})$/;
const HIGHEST_PORT = 65_535;

// Chrome takes more in a context's proxyServer than a proxy: an empty value or `direct://` sends the
// context straight out, even with a browser-wide proxy up, and a list or a socks entry goes elsewhere
// than the egress. So nothing but one http or https address with a port may reach a context's proxy.
// The value is left out of the reason, since a proxy's address can hold a password.
export function parseProxyServer(server: string): Result<ProxyServer, string> {
    const port = PROXY_ADDRESS.exec(server)?.[1];
    if (port === undefined || Number(port) === 0 || Number(port) > HIGHEST_PORT) {
        return failure("the session's egress named no proxy at one http(s)://host:port address");
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
// was started all the same, so it is closed here, and what its close said joins the reason.
export async function openSessionEgress(
    source: EgressSource,
    allowedOrigins: readonly string[],
): Promise<Result<OpenedSessionEgress, string>> {
    const started = await source(allowedOrigins);
    if (!started.ok) {
        return started;
    }
    const egress = started.value;
    const proxyServer = parseProxyServer(egress.proxy.server);
    if (!proxyServer.ok) {
        return failure(await reasonAfterClosing(proxyServer.error, egress));
    }
    return success({
        egress,
        contextProxy: {
            proxyServer: proxyServer.value,
            ...(egress.proxy.includeLoopback ? { proxyBypassList: LOOPBACK_THROUGH_PROXY } : {}),
        },
    });
}

async function reasonAfterClosing(reason: string, egress: SessionEgress): Promise<string> {
    const closed = await egress.close();
    return closed.ok ? reason : `${reason}; its egress did not close: ${closed.error}`;
}
