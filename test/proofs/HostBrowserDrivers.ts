// How the host-run proofs get a driver: the production composition root for what it covers, and for
// what they must watch or vary, a driver handed an egress source of the test's own.
import { cdpDriver, type CdpDriverOptions, type OwnBrowserDriver } from "@revisum/driver-cdp";
import type { BrowserDriver } from "@revisum/engine";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import type { EgressSourceForTest } from "#test-support/browser/SessionEgressForTest.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { buildAdapters } from "../../packages/cli/src/BuildAdapters.ts";

export const EXECUTABLE_OF_TARGET: Readonly<Record<BrowserTarget, string>> = {
    [BrowserTarget.Chrome]: BROWSERS.chrome,
    [BrowserTarget.HeadlessShell]: BROWSERS.chromeHeadlessShell,
};

export function driverWithEgress(
    options: Omit<CdpDriverOptions, "proxy" | "egress"> & { readonly egress: EgressSourceForTest },
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
