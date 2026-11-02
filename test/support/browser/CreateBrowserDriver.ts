// The one place browser tests make a driver, so what a driver runs on can change here alone.
import { cdpDriver, type CdpDriverOptions, type OwnBrowserDriver } from "@revisum/driver-cdp";
import type { BrowserDriver } from "@revisum/engine";
import { BROWSERS } from "../browsers.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "./BrowserTarget.ts";
import { driverOnSharedBrowser, isSharingBrowserInThisFile } from "./ShareBrowserInThisFile.ts";

export function createBrowserDriver(options: CdpDriverOptions): OwnBrowserDriver {
    return isSharingBrowserInThisFile() ? driverOnSharedBrowser(options) : cdpDriver(options);
}

const EXECUTABLE_OF_TARGET: Readonly<Record<BrowserTarget, string>> = {
    [BrowserTarget.Chrome]: BROWSERS.chrome,
    [BrowserTarget.HeadlessShell]: BROWSERS.chromeHeadlessShell,
};

type SharedDriverOptions = Omit<CdpDriverOptions, "executablePath">;

export const driverForTarget = (
    target: BrowserTarget,
    options: SharedDriverOptions = {},
): OwnBrowserDriver =>
    createBrowserDriver({ executablePath: EXECUTABLE_OF_TARGET[target], ...options });

// One new driver per target, by the adapter the project's matrix names for it.
export const driversForTargets = (
    targets: readonly BrowserTarget[],
    options: SharedDriverOptions = {},
): ReadonlyMap<string, BrowserDriver> =>
    new Map<string, BrowserDriver>(
        targets.map((target) => [ADAPTER_OF_TARGET[target], driverForTarget(target, options)]),
    );
