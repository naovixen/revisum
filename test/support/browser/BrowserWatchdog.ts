// Ends a browser and removes its profile when the test process that launched it dies, however it
// dies. A process killed outright runs no signal handler or exit hook, and outside Windows the
// browser sits in a process group of its own, so nothing else ends it. The watchdog is a small
// process of its own, detached so that a kill of the test's group misses it, and it holds one end of
// a pipe the test process holds the other end of: the pipe closes when that process goes.
// This file runs as that process, so it imports only Node built-ins.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// The driver's own prefix for a profile folder.
const PROFILE_PREFIX = "cdp-driver-";
const EXIT_WAIT_MILLISECONDS = 5_000;
const EXIT_POLL_MILLISECONDS = 50;

type WatchedBrowser = { readonly processId: number; readonly webSocketUrl: string };

export type BrowserWatchdog = {
    // For once the browser has been stopped. The watchdog then finds nothing left to do, and ends.
    release(): void;
};

export function startBrowserWatchdog(browser: WatchedBrowser): BrowserWatchdog {
    const watchdog = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), String(browser.processId), browser.webSocketUrl],
        { stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true },
    );
    const { stdin } = watchdog;
    // Without a watchdog a run still works, and this helper does not fail a test over it.
    watchdog.on("error", () => undefined);
    stdin.on("error", () => undefined);
    // Neither the watchdog nor its pipe may keep the test process from exiting.
    watchdog.unref();
    if (stdin instanceof Socket) {
        stdin.unref();
    }
    return { release: () => stdin.end() };
}

const readFileOrEmpty = (path: string): string => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
};

// The browser writes its DevTools port and path into its profile, and no other browser has that pair.
export function profileFolderOf(webSocketUrl: string): string | null {
    const { port, pathname } = new URL(webSocketUrl);
    const announced = `${port}\n${pathname}`;
    const candidates = readdirSync(tmpdir()).filter((name) => name.startsWith(PROFILE_PREFIX));
    const found = candidates.find(
        (name) => readFileOrEmpty(join(tmpdir(), name, "DevToolsActivePort")).trim() === announced,
    );
    return found === undefined ? null : join(tmpdir(), found);
}

// Asked of the browser, because a process id alone may by now belong to some other process, and
// only what the browser itself started may be ended.
async function isBrowserStillAnswering(webSocketUrl: string): Promise<boolean> {
    const { port } = new URL(webSocketUrl);
    try {
        const answer = await fetch(`http://127.0.0.1:${port}/json/version`);
        const version: unknown = await answer.json();
        return (
            typeof version === "object" &&
            version !== null &&
            "webSocketDebuggerUrl" in version &&
            version.webSocketDebuggerUrl === webSocketUrl
        );
    } catch {
        return false;
    }
}

function isProcessRunning(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

// Outside Windows the browser leads a process group that its other processes joined; on Windows its
// job object ends them with it.
function endBrowserProcesses(processId: number): void {
    try {
        process.kill(platform() === "win32" ? processId : -processId, "SIGKILL");
    } catch {
        // Already gone.
    }
}

async function endBrowserAndProfile(processId: number, webSocketUrl: string): Promise<void> {
    const profileFolder = profileFolderOf(webSocketUrl);
    if (await isBrowserStillAnswering(webSocketUrl)) {
        endBrowserProcesses(processId);
        const giveUpAt = Date.now() + EXIT_WAIT_MILLISECONDS;
        while (isProcessRunning(processId) && Date.now() < giveUpAt) {
            await pause(EXIT_POLL_MILLISECONDS);
        }
    }
    if (profileFolder !== null) {
        // The quoted key is Node's own option name.
        rmSync(profileFolder, { recursive: true, force: true, "maxRetries": 10, retryDelay: 200 });
    }
}

function watchParentProcess(processId: number, webSocketUrl: string): void {
    let hasBegun = false;
    const onParentGone = (): void => {
        if (!hasBegun) {
            hasBegun = true;
            void endBrowserAndProfile(processId, webSocketUrl).finally(() => process.exit(0));
        }
    };
    process.stdin.on("end", onParentGone);
    process.stdin.on("close", onParentGone);
    process.stdin.on("error", onParentGone);
    process.stdin.resume();
}

if (import.meta.main) {
    watchParentProcess(Number(process.argv[2]), process.argv[3] ?? "");
}
