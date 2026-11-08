import {
    cdpDriver,
    egressThroughExistingProxy,
    type EgressSource,
    type OwnBrowserDriver,
} from "@revisum/driver-cdp";
import {
    parseProxyRules,
    ProxyClient,
    readBrowserRefusals,
    startProxyServer,
} from "@revisum/runner";

// A host run's session goes through its own proxy. Only host runs allow declared private addresses,
// so internal staging and localhost keep working, and every other address is refused. A source says
// it failed by rejecting, which the driver turns into its own outcome.
const startHostSessionEgress: EgressSource = async (allowedOrigins) => {
    const rules = parseProxyRules({
        allowedOrigins,
        privateOrigins: allowedOrigins,
        rewrites: [],
    });
    if (!rules.ok) {
        throw new Error(rules.error.message);
    }
    const started = await startProxyServer(rules.value, { client: ProxyClient.Browser });
    if (!started.ok) {
        throw new Error(started.error.message);
    }
    const proxy = started.value;
    return {
        proxy: { server: proxy.url, includeLoopback: true },
        refusedOrigins: () => proxy.refusedOrigins(),
        connectionFailures: () => proxy.connectionFailures(),
        close: async () => {
            const closed = await proxy.close();
            if (!closed.ok) {
                throw new Error(closed.error.message);
            }
        },
    };
};

export const buildAdapters = {
    hostBrowserDriver({ executablePath }: { readonly executablePath: string }): OwnBrowserDriver {
        return cdpDriver({ executablePath, egress: startHostSessionEgress });
    },

    containerBrowserDriver({
        executablePath,
        proxyServer,
    }: {
        readonly executablePath: string;
        readonly proxyServer: string;
    }): OwnBrowserDriver {
        return cdpDriver({
            executablePath,
            // Everything but the container's own loopback goes through the run's egress proxy, which
            // is in another container, along with what it refused.
            egress: egressThroughExistingProxy(proxyServer, () => readBrowserRefusals(proxyServer)),
        });
    },
};
