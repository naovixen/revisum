// How the host-run proofs get a driver: the production composition root for what it covers, and for
// what they must watch or vary, a driver handed an egress source of the test's own. What these proofs
// assume about the session's egress is gathered here, so a change to it is a change to this file.
import { cdpDriver, type CdpDriverOptions, type OwnBrowserDriver } from "@revisum/driver-cdp";
import type { BrowserDriver } from "@revisum/engine";
import { startProxyServer } from "@revisum/runner";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { buildAdapters } from "../../packages/cli/src/BuildAdapters.ts";

export type SessionEgressForTest = {
    readonly proxy: { readonly server: string; readonly includeLoopback: boolean };
    refusedOrigins(): readonly string[];
    close(): Promise<void>;
};

export type EgressSourceForTest = (
    allowedOrigins: readonly string[],
) => Promise<SessionEgressForTest>;

export const EXECUTABLE_OF_TARGET: Readonly<Record<BrowserTarget, string>> = {
    [BrowserTarget.Chrome]: BROWSERS.chrome,
    [BrowserTarget.HeadlessShell]: BROWSERS.chromeHeadlessShell,
};

const BROWSER_CLIENT = { client: "browser", listenHost: "127.0.0.1" } as const;

// A session's egress on the real proxy, whose rules are the ones a host run gives it: every declared
// origin may reach a private address, and nothing else is let through.
export const realEgressSource: EgressSourceForTest = async (allowedOrigins) => {
    const proxy = await startProxyServer(
        { allowedOrigins, privateOrigins: allowedOrigins, rewrites: [] },
        BROWSER_CLIENT,
    );
    return {
        proxy: { server: proxy.url, includeLoopback: true },
        refusedOrigins: () =>
            proxy
                .decisions()
                .filter((entry) => entry.decision === "blocked")
                .map((entry) => String(entry.origin)),
        close: () => proxy.close(),
    };
};

export function driverWithEgress(
    options: Omit<CdpDriverOptions, "egress"> & { readonly egress: EgressSourceForTest },
): OwnBrowserDriver {
    return cdpDriver(options);
}

// One driver per target, built as a host run builds it.
export const hostBrowserDrivers = (
    targets: readonly BrowserTarget[],
): ReadonlyMap<string, BrowserDriver> =>
    new Map<string, BrowserDriver>(
        targets.map((target) => [
            ADAPTER_OF_TARGET[target],
            buildAdapters.hostBrowserDriver({ executablePath: EXECUTABLE_OF_TARGET[target] }),
        ]),
    );
