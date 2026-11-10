// The one place browser tests make a driver, so what a driver runs on can change here alone.
import { cdpDriver, type CdpDriverOptions, type OwnBrowserDriver } from "@revisum/driver-cdp";
import type { BrowserDriver } from "@revisum/engine";
import { BROWSERS } from "../Browsers.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "../BrowserTarget.ts";
import { realEgressSource, type EgressSourceForTest } from "./SessionEgressForTest.ts";
import { driverOnSharedBrowser, isSharingBrowserInThisFile } from "../ShareBrowserInThisFile.ts";

export type BrowserDriverOptions = Omit<CdpDriverOptions, "egress"> & {
    // Absent, each session gets a real proxy of its own, as on a host run.
    readonly egress?: EgressSourceForTest;
};

export function createBrowserDriver(options: BrowserDriverOptions): OwnBrowserDriver {
    const withEgress = { ...options, egress: options.egress ?? realEgressSource };
    return isSharingBrowserInThisFile() ? driverOnSharedBrowser(withEgress) : cdpDriver(withEgress);
}

const EXECUTABLE_OF_TARGET: Readonly<Record<BrowserTarget, string>> = {
    [BrowserTarget.Chrome]: BROWSERS.chrome,
    [BrowserTarget.HeadlessShell]: BROWSERS.chromeHeadlessShell,
};

type SharedDriverOptions = Omit<BrowserDriverOptions, "executablePath">;

export const driverForTarget = (
    target: BrowserTarget,
    options: SharedDriverOptions = {},
): OwnBrowserDriver =>
    createBrowserDriver({ executablePath: EXECUTABLE_OF_TARGET[target], ...options });

// A browser launched per session, as production does, even in a file that shares one: a browser's
// first page behaves differently from a later one.
export const driversOnFreshBrowsers = (
    targets: readonly BrowserTarget[],
): ReadonlyMap<string, BrowserDriver> =>
    new Map<string, BrowserDriver>(
        targets.map((target) => [
            ADAPTER_OF_TARGET[target],
            cdpDriver({ executablePath: EXECUTABLE_OF_TARGET[target], egress: realEgressSource }),
        ]),
    );

// One new driver per target, by the adapter the project's matrix names for it.
export const driversForTargets = (
    targets: readonly BrowserTarget[],
    options: SharedDriverOptions = {},
): ReadonlyMap<string, BrowserDriver> =>
    new Map<string, BrowserDriver>(
        targets.map((target) => [ADAPTER_OF_TARGET[target], driverForTarget(target, options)]),
    );
