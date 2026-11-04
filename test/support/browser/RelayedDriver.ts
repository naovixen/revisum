// A driver on the file's shared browser, reached through a relay whose replies a test may change.
// The driver takes the address of any browser it is told of, so nothing of its own is replaced. It
// is built here, not by createBrowserDriver, which gives a sharing file's driver its own browser
// source. Ask for it only in a file that calls shareBrowserInThisFile. A test that opens a second page
// keeps away from a shared browser, and asks for startRelayedDriverOnItsOwnBrowser instead.
import {
    cdpDriver,
    launchSharedBrowser,
    type LaunchedSharedBrowser,
    type OwnBrowserDriver,
} from "@revisum/driver-cdp";
import { BROWSERS } from "../browsers.ts";
import { startBrowserWatchdog, type BrowserWatchdog } from "./BrowserWatchdog.ts";
import { startCdpRelay, type CdpRelay } from "./CdpRelay.ts";
import { realEgressSource } from "./SessionEgressForTest.ts";
import { sharedBrowserFor } from "./ShareBrowserInThisFile.ts";

export type RelayedDriver = {
    readonly driver: OwnBrowserDriver;
    readonly relay: CdpRelay;
};

export async function startRelayedDriver(fixturesFolder?: string): Promise<RelayedDriver> {
    const relay = await startCdpRelay();
    const executablePath = BROWSERS.chrome;
    const driver = cdpDriver({
        executablePath,
        egress: realEgressSource,
        ...(fixturesFolder === undefined ? {} : { fixturesFolder }),
        browserSource: async (locale) => {
            const shared = await sharedBrowserFor({ executablePath, locale });
            relay.forwardTo(shared.webSocketUrl);
            return { ...shared, webSocketUrl: relay.url };
        },
    });
    return { driver, relay };
}

export type RelayedDriverOnItsOwnBrowser = RelayedDriver & {
    // Ends the relay and the browser. For once the driver's session has closed.
    close(): Promise<void>;
};

type LaunchedForOneDriver = {
    readonly browser: LaunchedSharedBrowser;
    readonly watchdog: BrowserWatchdog;
};

// A driver on a browser launched for it alone, which no other session ever runs on, reached through a
// relay as above. Only a browser source gives the driver an address to connect to, so this launches
// the browser as one, and is the source of no other driver. Nothing is launched until a session opens.
export async function startRelayedDriverOnItsOwnBrowser(): Promise<RelayedDriverOnItsOwnBrowser> {
    const relay = await startCdpRelay();
    const executablePath = BROWSERS.chrome;
    let launching: Promise<LaunchedForOneDriver> | undefined;
    const launch = async (locale: string): Promise<LaunchedForOneDriver> => {
        const browser = await launchSharedBrowser({ executablePath, locale });
        return { browser, watchdog: startBrowserWatchdog(browser) };
    };
    const driver = cdpDriver({
        executablePath,
        egress: realEgressSource,
        browserSource: async (locale) => {
            launching ??= launch(locale);
            const { browser } = await launching;
            relay.forwardTo(browser.webSocketUrl);
            return { ...browser, webSocketUrl: relay.url };
        },
    });
    return {
        driver,
        relay,
        async close() {
            await relay.close();
            const launched = await launching;
            if (launched !== undefined) {
                try {
                    await launched.browser.stop();
                } finally {
                    launched.watchdog.release();
                }
            }
        },
    };
}
