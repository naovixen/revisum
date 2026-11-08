// How a session gets its browser: one it launches for itself, or one shared with sessions that ran
// before it. A session on a shared browser has its own connection and browser context, and closing
// that connection makes the browser dispose of the context, its pages and every setting the session
// made. The browser's process, launch flags and clipboard stay, so sessions run strictly one at a
// time, a browser only takes the settings it was launched with, and a session reads no clipboard.
// A key press can still paste what an earlier session copied, so tests that copy or paste keep to a
// browser of their own. Each session's egress proxy goes on its context, so every browser holds a dead
// browser-wide one for Chrome's own traffic.
import { GET_BROWSER_CONTEXTS } from "../connection/BrowserCommand.ts";
import { CdpConnection } from "../connection/CdpConnection.ts";
import { sessionEgressChromeFlags } from "./SessionEgressChromeFlags.ts";
import { launchChromium, type LaunchedChromium } from "./LaunchChromium.ts";
import { holdDeadProxy } from "./HoldDeadProxy.ts";

const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_LAUNCH_TIMEOUT_MILLISECONDS = 30_000;
// Disposing of a context takes tens of milliseconds, even with a dialog open or a page stuck in a loop.
const CONTEXT_GONE_TIMEOUT_MILLISECONDS = 10_000;
const CONTEXT_POLL_MILLISECONDS = 5;

// What a browser is launched with and cannot change for one browser context.
type LaunchSettings = {
    readonly executablePath: string;
    readonly locale: string;
};

export type SharedBrowser = LaunchSettings & {
    readonly webSocketUrl: string;
    readonly processId: number;
    isAlive(): boolean;
};

export type LaunchedSharedBrowser = SharedBrowser & {
    // Ends the browser and removes its profile. Nothing else ends it, so an unstopped one outlives
    // the tests and keeps their process from exiting.
    stop(): Promise<void>;
};

// Asked once per session for a browser launched for that locale. The executable is the driver's own,
// so a source serves one driver's settings and keeps a browser per locale.
export type BrowserSource = (locale: string) => Promise<SharedBrowser>;

// The browser a session runs on, however it got it.
export type AttachedBrowser = {
    readonly connection: CdpConnection;
    readonly processId: number;
    readonly isShared: boolean;
    // Ends the session's use of the browser. Once it resolves, nothing of the session runs.
    close(): Promise<void>;
};

// The dead proxy lasts exactly as long as the browser: a port let go while the browser ran could be
// taken by another program, so it closes only once the browser has ended, however it ended.
async function launchDriverChromium(
    settings: LaunchSettings,
    launchTimeoutMilliseconds = DEFAULT_LAUNCH_TIMEOUT_MILLISECONDS,
): Promise<LaunchedChromium> {
    const deadProxy = await holdDeadProxy();
    let launched: LaunchedChromium;
    try {
        launched = await launchChromium(settings.executablePath, {
            arguments: [...sessionEgressChromeFlags(deadProxy.server), `--lang=${settings.locale}`],
            launchTimeoutMilliseconds,
            commandTimeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS,
            profilePrefix: "cdp-driver-",
        });
    } catch (error) {
        await deadProxy.close();
        throw error;
    }
    void launched.exited.then(() => deadProxy.close());
    return {
        ...launched,
        stop: async () => {
            try {
                await launched.stop();
            } finally {
                await deadProxy.close();
            }
        },
    };
}

const browserOfItsOwn = (launched: LaunchedChromium): AttachedBrowser => ({
    connection: launched.connection,
    processId: launched.browserProcess.pid ?? -1,
    isShared: false,
    close: () => launched.stop(),
});

export const launchOwnBrowser = async (
    settings: LaunchSettings,
    launchTimeoutMilliseconds?: number,
): Promise<AttachedBrowser> =>
    browserOfItsOwn(await launchDriverChromium(settings, launchTimeoutMilliseconds));

export async function launchSharedBrowser(
    settings: LaunchSettings,
    launchTimeoutMilliseconds?: number,
): Promise<LaunchedSharedBrowser> {
    const launched = await launchDriverChromium(settings, launchTimeoutMilliseconds);
    const { browserProcess } = launched;
    return {
        ...settings,
        webSocketUrl: launched.webSocketUrl,
        processId: browserProcess.pid ?? -1,
        isAlive: () => browserProcess.exitCode === null && browserProcess.signalCode === null,
        stop: () => launched.stop(),
    };
}

// Browsers with a session on them. A session that never closes, or whose context never went, keeps
// its browser here, so no later session can run alongside what is left of it.
const browsersInUse = new WeakSet<SharedBrowser>();

function whyRefused(shared: SharedBrowser, wanted: LaunchSettings): string | null {
    if (!shared.isAlive()) {
        return "the shared browser has died";
    }
    if (shared.executablePath !== wanted.executablePath) {
        return "the shared browser runs another executable";
    }
    if (shared.locale !== wanted.locale) {
        return `the shared browser was launched for locale ${shared.locale}, not ${wanted.locale}`;
    }
    if (browsersInUse.has(shared)) {
        return "another session has not finished closing on the shared browser";
    }
    return null;
}

const browserContexts = async (connection: CdpConnection): Promise<readonly string[]> => {
    const { browserContextIds } = await connection.ask(undefined, GET_BROWSER_CONTEXTS, {});
    return browserContextIds;
};

export async function attachToSharedBrowser(
    shared: SharedBrowser,
    wanted: LaunchSettings,
): Promise<AttachedBrowser> {
    const refusal = whyRefused(shared, wanted);
    if (refusal !== null) {
        throw new Error(refusal);
    }
    browsersInUse.add(shared);
    let connection: CdpConnection | undefined;
    try {
        connection = await CdpConnection.open(shared.webSocketUrl, {
            commandTimeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS,
        });
        if ((await browserContexts(connection)).length > 0) {
            throw new Error("the shared browser already has a session's browser context in it");
        }
    } catch (error) {
        connection?.close();
        browsersInUse.delete(shared);
        throw error;
    }
    const opened = connection;
    let closing: Promise<void> | undefined;
    return {
        connection: opened,
        processId: shared.processId,
        isShared: true,
        close: () => {
            closing ??= closeSharedSession(shared, opened);
            return closing;
        },
    };
}

// The closing connection is deliberate, so nothing counts it as lost: the session ends its own pages. It makes
// the browser dispose of the session's context, without the session being able to see that happen.
async function closeSharedSession(shared: SharedBrowser, connection: CdpConnection): Promise<void> {
    connection.close();
    await waitUntilContextsAreGone(shared);
    browsersInUse.delete(shared);
}

// Asks over a new connection, since the session's own has gone. A browser that has died has no
// contexts left, and the next session on it is refused.
async function waitUntilContextsAreGone(shared: SharedBrowser): Promise<void> {
    const giveUpAt = Date.now() + CONTEXT_GONE_TIMEOUT_MILLISECONDS;
    const options = {
        connectTimeoutMilliseconds: CONTEXT_GONE_TIMEOUT_MILLISECONDS,
        commandTimeoutMilliseconds: CONTEXT_GONE_TIMEOUT_MILLISECONDS,
    };
    let control: CdpConnection | undefined;
    try {
        while (shared.isAlive()) {
            if (Date.now() >= giveUpAt) {
                throw new Error(
                    `the shared browser kept the session's browser context for ${CONTEXT_GONE_TIMEOUT_MILLISECONDS} ms; stop it and launch another`,
                );
            }
            try {
                control ??= await CdpConnection.open(shared.webSocketUrl, options);
                if ((await browserContexts(control)).length === 0) {
                    return;
                }
            } catch {
                // The browser is dying or the connection dropped: isAlive and the limit decide.
                control?.close();
                control = undefined;
            }
            await new Promise((resolve) => setTimeout(resolve, CONTEXT_POLL_MILLISECONDS));
        }
    } finally {
        control?.close();
    }
}
