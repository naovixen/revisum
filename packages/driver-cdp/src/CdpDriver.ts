// The own CDP driver: launches Chromium itself and speaks the Chrome DevTools Protocol over a
// WebSocket, with no third-party automation library.
import { failure, success } from "@revisum/contracts";
import { openSessionEgress, type EgressSource } from "./capabilities/SessionEgress.ts";
import { errorText } from "./connection/ErrorText.ts";
import { chromiumBuild } from "./launch/ChromiumBuild.ts";
import {
    attachToSharedBrowser,
    launchOwnBrowser,
    type AttachedBrowser,
    type BrowserSource,
} from "./launch/SharedBrowser.ts";
import { createSession } from "./session/CreateSession.ts";
import type { OwnBrowserDriver } from "./session/DriverSession.ts";

const CDP_ADAPTER_VERSION = "0.1.0";
const NOT_CHROMIUM = "CDP drives Chromium only";

export type CdpDriverOptions = {
    readonly executablePath: string;
    readonly launchTimeoutMilliseconds?: number;
    // The project's fixtures folder. An upload step sends a declared fixture from here, and a stub
    // serves one from here, never a file outside it. Without it, the driver refuses every upload and
    // every stub with a fixture body.
    readonly fixturesFolder?: string;
    // Gives each session an egress proxy of its own, on its browser context. The browser-wide proxy is
    // a dead one, for Chrome's own traffic.
    readonly egress: EgressSource;
    // Where sessions get a browser someone else launched. Without it, as in production, every session
    // launches a browser of its own and ends it on close.
    readonly browserSource?: BrowserSource;
};

export function cdpDriver(options: CdpDriverOptions): OwnBrowserDriver {
    return {
        info: {
            id: "cdp",
            version: CDP_ADAPTER_VERSION,
            protocol: "Chrome DevTools Protocol (raw WebSocket)",
        },
        supports(target) {
            if (target.engine !== "chromium") {
                return failure({ reason: "engine-not-supported", detail: NOT_CHROMIUM });
            }
            return success(true);
        },
        build(target) {
            return Promise.resolve(
                target.engine === "chromium"
                    ? chromiumBuild(options.executablePath)
                    : failure({ code: "engine-not-supported", detail: NOT_CHROMIUM }),
            );
        },
        async open(target, environment) {
            if (target.engine !== "chromium") {
                return failure({ reason: "engine-not-supported", detail: NOT_CHROMIUM });
            }
            const opened = await openSessionEgress(options.egress, environment.allowedOrigins);
            if (!opened.ok) {
                return failure({ reason: "launch-failed", detail: opened.error });
            }
            const sessionEgress = opened.value;
            const closeEgress = (): Promise<void> => sessionEgress.egress.close();
            let attached: AttachedBrowser;
            try {
                attached = await attachBrowser(options, target.locale);
            } catch (error) {
                return failure({
                    reason: "launch-failed",
                    detail: await detailAfterClosing(error, [closeEgress]),
                });
            }
            try {
                return success(
                    await createSession(
                        attached,
                        sessionEgress,
                        target,
                        environment,
                        options.fixturesFolder,
                    ),
                );
            } catch (error) {
                // A shared browser that keeps this context stays refused to later sessions, so what to
                // report first here is what stopped this one opening.
                return failure({
                    reason: "launch-failed",
                    detail: await detailAfterClosing(error, [() => attached.close(), closeEgress]),
                });
            }
        },
    };
}

function attachBrowser(options: CdpDriverOptions, locale: string): Promise<AttachedBrowser> {
    const { executablePath, browserSource, launchTimeoutMilliseconds } = options;
    const settings = { executablePath, locale };
    if (browserSource !== undefined) {
        return browserSource(locale).then((shared) => attachToSharedBrowser(shared, settings));
    }
    return launchOwnBrowser(settings, launchTimeoutMilliseconds);
}

// Why a session did not open, then anything that also went wrong clearing up after it.
async function detailAfterClosing(
    error: unknown,
    closers: readonly (() => Promise<void>)[],
): Promise<string> {
    const details = [errorText(error)];
    for (const close of closers) {
        try {
            await close();
        } catch (closeError) {
            details.push(`closing what it had opened failed too: ${errorText(closeError)}`);
        }
    }
    return details.join("; ");
}
