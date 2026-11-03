// One browser per test file, for the files that ask: a launch costs far more than a session, and a
// session on a shared browser has its own connection and browser context. Node runs each test file
// in a process of its own, so what is kept here is one file's. A file that does not ask launches a
// browser per session, as production does.
// Ask only in a file that copies or pastes nothing, kills no browser, checks no process exit, opens
// no second page in a session and proves no published guarantee: see the shared browser's limits in
// the driver's SharedBrowser.ts.
import { after } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
    CdpConnection,
    cdpDriver,
    launchSharedBrowser,
    type CdpDriverOptions,
    type LaunchedSharedBrowser,
    type OwnBrowserDriver,
    type SharedBrowser,
} from "@revisum/driver-cdp";
import type { SessionEnvironment, Target } from "@revisum/engine";
import { startBrowserWatchdog, type BrowserWatchdog } from "./BrowserWatchdog.ts";
import type { EgressSourceForTest, SessionEgressForTest } from "./SessionEgressForTest.ts";
import { driverWith, sessionWith } from "./WrappingSessions.ts";

const CONTROL_TIMEOUT_MILLISECONDS = 5_000;
const EXIT_POLL_MILLISECONDS = 10;

// Each session's proxy goes on its own browser context, so what a browser is launched for is only its
// executable and locale.
type LaunchSettings = { readonly executablePath: string; readonly locale: string };

type HeldBrowser = {
    readonly browser: LaunchedSharedBrowser;
    readonly watchdog: BrowserWatchdog;
    // A session failed to open or close on it, so the driver would refuse the next one.
    isStuck: boolean;
};

let isSharingInThisFile = false;
const heldBrowsers = new Map<string, Promise<HeldBrowser>>();
const egressStillOpen = new Set<SessionEgressForTest>();

// A session a failed test left open never closes its egress, whose listening proxy would keep the
// file's process from exiting, so what it costs is no longer only that test.
const closedWithTheFile =
    (source: EgressSourceForTest): EgressSourceForTest =>
    async (allowedOrigins) => {
        const egress = await source(allowedOrigins);
        egressStillOpen.add(egress);
        return {
            ...egress,
            close: () => {
                egressStillOpen.delete(egress);
                return egress.close();
            },
        };
    };

const keyOf = ({ executablePath, locale }: LaunchSettings): string =>
    JSON.stringify([executablePath, locale]);

async function launchHeldBrowser(
    settings: LaunchSettings,
    launchTimeoutMilliseconds: number | undefined,
): Promise<HeldBrowser> {
    const browser = await launchSharedBrowser(settings, launchTimeoutMilliseconds);
    return { browser, watchdog: startBrowserWatchdog(browser), isStuck: false };
}

const openControlConnection = (browser: SharedBrowser): Promise<CdpConnection> =>
    CdpConnection.open(browser.webSocketUrl, {
        connectTimeoutMilliseconds: CONTROL_TIMEOUT_MILLISECONDS,
        commandTimeoutMilliseconds: CONTROL_TIMEOUT_MILLISECONDS,
    });

// The launcher's stop() waits for a browser still exiting behind a 5 s timer it never clears, and
// that timer alone keeps a file's process alive for up to 5 s after its last test. Asked to stop a
// browser that has already exited, it starts no such timer.
async function closeBrowserAndWaitForExit(browser: SharedBrowser): Promise<void> {
    let control: CdpConnection | undefined;
    try {
        control = await openControlConnection(browser);
        control.expectClose();
        await control.send(undefined, "Browser.close");
    } catch {
        // A browser that closes may drop the connection before it answers; stop() deals with the rest.
    } finally {
        control?.close();
    }
    const giveUpAt = Date.now() + CONTROL_TIMEOUT_MILLISECONDS;
    while (browser.isAlive() && Date.now() < giveUpAt) {
        await pause(EXIT_POLL_MILLISECONDS);
    }
}

async function stopHeldBrowser(held: HeldBrowser): Promise<void> {
    try {
        await closeBrowserAndWaitForExit(held.browser);
        await held.browser.stop();
    } finally {
        held.watchdog.release();
    }
}

// A context still in the browser is a session that never closed, or one whose close gave up.
async function hasNoSessionLeft(browser: SharedBrowser): Promise<boolean> {
    let control: CdpConnection | undefined;
    try {
        control = await openControlConnection(browser);
        const { browserContextIds } = await control.send<{
            browserContextIds: readonly string[];
        }>(undefined, "Target.getBrowserContexts");
        return browserContextIds.length === 0;
    } catch {
        return false;
    } finally {
        control?.close();
    }
}

const canTakeSession = async (held: HeldBrowser): Promise<boolean> =>
    !held.isStuck && held.browser.isAlive() && (await hasNoSessionLeft(held.browser));

// The file's browser for these settings, launched if there is none yet. One that died, or that a
// failed test left a session on, is replaced, so only the test that left it fails.
export async function sharedBrowserFor(
    settings: LaunchSettings,
    launchTimeoutMilliseconds?: number,
): Promise<SharedBrowser> {
    const key = keyOf(settings);
    const held = await heldBrowsers.get(key)?.catch(() => undefined);
    if (held !== undefined) {
        if (await canTakeSession(held)) {
            return held.browser;
        }
        await stopHeldBrowser(held).catch(() => undefined);
    }
    const launching = launchHeldBrowser(settings, launchTimeoutMilliseconds);
    heldBrowsers.set(key, launching);
    return (await launching).browser;
}

async function markStuck(settings: LaunchSettings): Promise<void> {
    const held = await heldBrowsers.get(keyOf(settings))?.catch(() => undefined);
    if (held !== undefined) {
        held.isStuck = true;
    }
}

export async function stopSharedBrowsers(): Promise<void> {
    const held = [...heldBrowsers.values()];
    heldBrowsers.clear();
    const egress = [...egressStillOpen];
    egressStillOpen.clear();
    await Promise.allSettled([
        ...held.map(async (launching) => {
            await stopHeldBrowser(await launching);
        }),
        ...egress.map((left) => left.close()),
    ]);
}

export function shareBrowserInThisFile(): void {
    if (!isSharingInThisFile) {
        isSharingInThisFile = true;
        after(stopSharedBrowsers);
    }
}

export const isSharingBrowserInThisFile = (): boolean => isSharingInThisFile;

export function driverOnSharedBrowser(
    options: Omit<CdpDriverOptions, "egress"> & {
        readonly egress: EgressSourceForTest;
    },
): OwnBrowserDriver {
    const { executablePath, launchTimeoutMilliseconds } = options;
    const settingsFor = (locale: string): LaunchSettings => ({ executablePath, locale });
    const inner = cdpDriver({
        ...options,
        egress: closedWithTheFile(options.egress),
        browserSource: (locale) => sharedBrowserFor(settingsFor(locale), launchTimeoutMilliseconds),
    });
    return driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            if (!opened.ok) {
                await markStuck(settingsFor(target.locale));
                return opened;
            }
            const session = opened.value;
            const close = async (): Promise<void> => {
                try {
                    await session.close();
                } catch (error) {
                    await markStuck(settingsFor(target.locale));
                    throw error;
                }
            };
            return { ok: true as const, value: sessionWith(session, { close }) };
        },
    });
}
