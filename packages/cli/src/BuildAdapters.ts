import { cdpDriver, type OwnBrowserDriver } from "@revisum/driver-cdp";

export const buildAdapters = {
    hostBrowserDriver({ executablePath }: { readonly executablePath: string }): OwnBrowserDriver {
        return cdpDriver({ executablePath });
    },

    containerBrowserDriver({
        executablePath,
        proxyServer,
    }: {
        readonly executablePath: string;
        readonly proxyServer: string | undefined;
    }): OwnBrowserDriver {
        return cdpDriver({
            executablePath,
            // Everything but the container's own loopback goes through the run's egress proxy.
            ...(proxyServer === undefined || proxyServer === ""
                ? {}
                : { proxy: { server: proxyServer, includeLoopback: false } }),
        });
    },
};
