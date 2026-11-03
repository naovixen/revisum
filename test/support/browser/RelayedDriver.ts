// A driver on the file's shared browser, reached through a relay whose replies a test may change.
// The driver takes the address of any browser it is told of, so nothing of its own is replaced. It
// is built here, not by createBrowserDriver, which gives a sharing file's driver its own browser
// source. Ask for it only in a file that calls shareBrowserInThisFile.
import { cdpDriver, type OwnBrowserDriver } from "@revisum/driver-cdp";
import { BROWSERS } from "../browsers.ts";
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
