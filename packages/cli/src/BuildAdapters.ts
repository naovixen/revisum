import {
    cdpDriver,
    egressThroughExistingProxy,
    type EgressSource,
    type OwnBrowserDriver,
} from "@revisum/driver-cdp";
import { ProxyClient, readBrowserRefusals, startProxyServer } from "@revisum/runner";

// A host run's session goes through its own proxy. Only host runs allow declared private addresses,
// so internal staging and localhost keep working, and every other address is refused.
const startHostSessionEgress: EgressSource = async (allowedOrigins) => {
    const proxy = await startProxyServer(
        { allowedOrigins, privateOrigins: allowedOrigins, rewrites: [] },
        { client: ProxyClient.Browser },
    );
    return {
        proxy: { server: proxy.url, includeLoopback: true },
        refusedOrigins: () =>
            proxy
                .decisions()
                .filter((entry) => entry.decision === "blocked")
                .map((entry) => entry.origin),
        connectionFailures: () => proxy.connectionFailures(),
        close: () => proxy.close(),
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
