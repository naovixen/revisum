// Starts a headless Chromium with a throwaway profile, waits for its DevTools address and
// connects. Stopping it ends the browser and removes the profile folder, always ends in time, and
// says what it could not do.
// Outside Windows the browser starts in a process group of its own, which its zygote, GPU,
// utility and renderer processes join. Those may outlive the browser process by a moment, so
// stopping waits until the whole group has exited, and ends what is left of it after a grace
// period. Only that group is ever signalled: it holds nothing the driver did not start. On
// Windows there are no such groups, so stopping ends the browser's process tree instead.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CLOSE_BROWSER } from "./BrowserCommand.ts";
import { CdpConnection, type ConnectOptions } from "./cdp-connection.ts";
import { PORT_RANDOMISATION_FEATURE, WEBRTC_UDP_OFF_FLAGS } from "./chrome-flags.ts";
import { windowsProcessesLeft } from "./WindowsProcessesLeft.ts";

// Flags for an isolated, repeatable page: no network outside 127.0.0.1, which takes turning WebRTC's
// UDP off as well as the resolver rule, since a page can send it to an address with no name to resolve.
// No first-run UI or background traffic, fixed scale factor and font hinting, and no random local ports
// (see chrome-flags.ts). Used by default.
const ISOLATED_CHROMIUM_ARGUMENTS: readonly string[] = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--font-render-hinting=none",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-features=${PORT_RANDOMISATION_FEATURE}`,
    ...WEBRTC_UDP_OFF_FLAGS,
];

// Added to every launch, even when the caller passes its own flags, so no caller can open a
// visible window or play sound on the person's machine.
const ALWAYS_HEADLESS_AND_MUTED: readonly string[] = ["--headless=new", "--mute-audio"];

type LaunchOptions = ConnectOptions & {
    // Flags passed to Chromium. The launcher always adds headless mode, muted audio, the DevTools
    // port, the profile folder and a blank first page.
    readonly arguments?: readonly string[];
    readonly launchTimeoutMilliseconds?: number;
    readonly profilePrefix?: string;
};

export type LaunchedChromium = {
    readonly connection: CdpConnection;
    readonly browserProcess: ChildProcess;
    readonly webSocketUrl: string;
    readonly userDataFolder: string;
    // Settles once the browser process has ended, whatever ended it.
    readonly exited: Promise<void>;
    // Ends the browser's process tree on Windows, or elsewhere asks it to close and ends its process group.
    // Where the tree could not be ended it asks the browser to close there too, and forces it after a grace
    // period. Then it removes the profile folder. Always ends inside 30 seconds. Rejects naming
    // what it left, a process or a folder, and resolves when it left nothing, however it got there. Stopping
    // again gives the same answer.
    stop(): Promise<void>;
};

const DEVTOOLS_ANNOUNCEMENT = /DevTools listening on (ws:\/\/\S+)/;
const OUTPUT_LIMIT = 64 * 1024;

// The limits of a stop's stages, which come one after another. Only a stop where each stage wedges can reach
// their sum, which is under 30 seconds.
const TASKKILL_LIMIT_MILLISECONDS = 5_000;
const CLOSE_LIMIT_MILLISECONDS = 4_000;
const FORCE_AFTER_MILLISECONDS = 3_000;
const EXIT_GRACE_MILLISECONDS = 4_000;
const EXIT_WHEN_FORCED_MILLISECONDS = 1_000;
const FOLDER_RELEASE_MILLISECONDS = 4_000;
const FOLDER_REMOVAL_MILLISECONDS = 3_000;
const FOLDER_RELEASE_CHECK_MILLISECONDS = 50;

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
const codeOf = (error: unknown): unknown =>
    error instanceof Error && "code" in error ? error.code : undefined;

const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

// True when the work settled in time. A pending timer would keep this process alive after the work is done.
async function settledWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
            resolve(false);
        }, milliseconds);
    });
    try {
        return await Promise.race([work.then(() => true), limit]);
    } finally {
        clearTimeout(timer);
    }
}

// How a folder fails to move while Windows still holds something inside it.
const HELD_FOLDER = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"];

// Takes the folder out of the way once nothing holds it, and gives where it now is, or null when it was not
// there. A process's handles go a moment after the process does, and nothing reports it, so this waits for
// that, by moving the folder, under one deadline: moving a folder that is held does nothing at all, so what
// repeats is a question, and what removes the folder is sent once, by the caller. Rejects with what holds it
// up at the deadline.
async function movedOnceReleased(folder: string): Promise<string | null> {
    const moved = `${folder}-being-removed`;
    const giveUpAt = Date.now() + FOLDER_RELEASE_MILLISECONDS;
    for (;;) {
        try {
            await rename(folder, moved);
            return moved;
        } catch (error) {
            if (codeOf(error) === "ENOENT") {
                return null;
            }
            if (!HELD_FOLDER.includes(String(codeOf(error))) || Date.now() >= giveUpAt) {
                throw error;
            }
        }
        await pause(FOLDER_RELEASE_CHECK_MILLISECONDS);
    }
}

// Removes a profile folder. What it could not remove, or null.
async function folderLeftBehind(folder: string): Promise<string | null> {
    try {
        const moved = await movedOnceReleased(folder);
        if (moved === null) {
            return null;
        }
        const removing = rm(moved, { recursive: true, force: true });
        return (await settledWithin(removing, FOLDER_REMOVAL_MILLISECONDS))
            ? null
            : `the folder ${moved}, still being removed after ${FOLDER_REMOVAL_MILLISECONDS} ms`;
    } catch (error) {
        return `the folder ${folder} (${messageOf(error)})`;
    }
}

const hasExited = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

const OWN_PROCESS_GROUP = platform() !== "win32";
const GROUP_GRACE_MILLISECONDS = 2_000;
const GROUP_FORCED_MILLISECONDS = 2_000;
const GROUP_POLL_MILLISECONDS = 25;

// Whether any process of the group still runs. On Linux a zombie (exited, its status not yet
// collected by its parent) runs nothing, so it does not count.
function groupRunning(groupId: number): boolean {
    if (platform() === "linux") {
        for (const name of readdirSync("/proc")) {
            if (!/^\d+$/.test(name)) {
                continue;
            }
            let status: string;
            try {
                status = readFileSync(`/proc/${name}/stat`, "utf8");
            } catch {
                continue;
            }
            // After the command name, in brackets: state, parent process id, process group id.
            const [state, , group] = status.slice(status.lastIndexOf(")") + 2).split(" ");
            if (Number(group) === groupId && state !== "Z") {
                return true;
            }
        }
        return false;
    }
    try {
        process.kill(-groupId, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// Waits until the group has no running process, for at most `milliseconds`. True when it has none.
async function groupEnded(groupId: number, milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (groupRunning(groupId)) {
        if (Date.now() >= deadline) {
            return false;
        }
        await pause(GROUP_POLL_MILLISECONDS);
    }
    return true;
}

// Once the browser process has exited, waits for the rest of its process group, and ends any of
// it still running after the grace period. True when none of it runs.
async function endProcessGroup(groupId: number | undefined): Promise<boolean> {
    if (!OWN_PROCESS_GROUP || groupId === undefined) {
        return true;
    }
    if (await groupEnded(groupId, GROUP_GRACE_MILLISECONDS)) {
        return true;
    }
    // Whether this worked is what the wait below finds out, whichever way it fails.
    try {
        process.kill(-groupId, "SIGKILL");
    } catch {
        /* ended meanwhile, or it runs on and is reported */
    }
    return groupEnded(groupId, GROUP_FORCED_MILLISECONDS);
}

// How ending the tree went: whyNot is null when it was not tried, because there is no tree to end.
type TreeEnding = { readonly hasEnded: boolean; readonly whyNot: string | null };
const TREE_NOT_TRIED: TreeEnding = { hasEnded: false, whyNot: null };
const treeNotEnded = (whyNot: string): TreeEnding => ({ hasEnded: false, whyNot });

// The browser's crashpad handlers answer to no job object, and under load outlive it by half a minute.
// taskkill finds them through parent ids, so it has to run while the browser is alive: it replaces
// asking the browser to close, rather than following it. Node holds the process's handle until it has
// seen the exit, so until then the id can't belong to anything else. A taskkill that does not answer is
// ended: it is this stop's own, and nothing it could still do is worth waiting past the limit for.
function endWindowsProcessTree(browserProcess: ChildProcess): Promise<TreeEnding> {
    if (OWN_PROCESS_GROUP || browserProcess.pid === undefined || hasExited(browserProcess)) {
        return Promise.resolve(TREE_NOT_TRIED);
    }
    return new Promise((resolve) => {
        const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(browserProcess.pid)], {
            stdio: "ignore",
            windowsHide: true,
        });
        const limit = setTimeout(() => {
            taskkill.kill();
            taskkill.unref();
            resolve(
                treeNotEnded(`taskkill did not answer within ${TASKKILL_LIMIT_MILLISECONDS} ms`),
            );
        }, TASKKILL_LIMIT_MILLISECONDS);
        taskkill.once("exit", (code) => {
            clearTimeout(limit);
            resolve(
                code === 0
                    ? { hasEnded: true, whyNot: null }
                    : treeNotEnded(`taskkill exited with code ${String(code)}`),
            );
        });
        taskkill.once("error", (error) => {
            clearTimeout(limit);
            resolve(treeNotEnded(`taskkill could not run: ${error.message}`));
        });
    });
}

// Waits for a clean exit first, and forces the process after a grace period. True when it has exited.
async function hasBrowserExitedInTime(
    browserProcess: ChildProcess,
    exited: Promise<void>,
): Promise<boolean> {
    const force = setTimeout(() => {
        browserProcess.kill();
    }, FORCE_AFTER_MILLISECONDS);
    const hasExitedByItself = await settledWithin(exited, EXIT_GRACE_MILLISECONDS);
    clearTimeout(force);
    if (hasExitedByItself) {
        return true;
    }
    browserProcess.kill();
    return settledWithin(exited, EXIT_WHEN_FORCED_MILLISECONDS);
}

// Which of the browser's other processes run on, on Windows, where what ended the browser did not end them
// too. What stop has waited for on every platform is a grace period past the browser's exit, so what still
// runs after one is what counts as left.
async function windowsProcessesLeftBehind(
    folder: string,
    browserProcess: ChildProcess,
    ending: TreeEnding,
): Promise<readonly string[]> {
    if (OWN_PROCESS_GROUP || ending.hasEnded || browserProcess.pid === undefined) {
        return [];
    }
    try {
        return (await windowsProcessesLeft(folder, GROUP_GRACE_MILLISECONDS)).map(
            (processId) => `the process ${processId}`,
        );
    } catch (error) {
        return [`whatever still runs, as it could not be told (${messageOf(error)})`];
    }
}

// Ends what a launch started and removes its folder, rejecting with whatever it could not.
async function stopBrowser(
    browserProcess: ChildProcess,
    exited: Promise<void>,
    userDataFolder: string,
    connection: CdpConnection | null,
): Promise<void> {
    connection?.expectClose();
    const ending = await endWindowsProcessTree(browserProcess);
    // A failed ask is expected of a browser that has gone or stopped answering. It says nothing by itself,
    // as the wait below finds out whether the browser went, and is only part of why if it did not.
    const whyNotClosed =
        connection === null || ending.hasEnded
            ? null
            : await connection.ask(undefined, CLOSE_BROWSER, {}, CLOSE_LIMIT_MILLISECONDS).then(
                  () => null,
                  (error: unknown) => `asking it to close failed: ${messageOf(error)}`,
              );
    const processId = browserProcess.pid;
    const processesLeft = [
        ...((await hasBrowserExitedInTime(browserProcess, exited))
            ? []
            : [`the browser process ${String(processId)}`]),
        ...((await endProcessGroup(processId)) ? [] : [`the process group ${String(processId)}`]),
        ...(await windowsProcessesLeftBehind(userDataFolder, browserProcess, ending)),
    ];
    connection?.close();
    const folderLeft = await folderLeftBehind(userDataFolder);
    const why = [ending.whyNot, whyNotClosed].filter((reason) => reason !== null);
    const named =
        processesLeft.length === 0 || why.length === 0
            ? processesLeft.join(", ")
            : `${processesLeft.join(", ")} (${why.join("; ")})`;
    const left = [...(named === "" ? [] : [named]), ...(folderLeft === null ? [] : [folderLeft])];
    if (left.length > 0) {
        throw new Error(`stopping the browser left ${left.join(" and ")}`);
    }
}

// Whatever its type says, a process Node ran out of file handles to start has no streams at all:
// Node stops before making them, and reports the failure through the 'error' event.
function outputStreamsOf(child: ChildProcess): readonly Readable[] {
    const streams: readonly (Readable | null | undefined)[] = [child.stdout, child.stderr];
    return streams.filter((stream) => stream !== null && stream !== undefined);
}

// The DevTools address the browser announces. Rejects when it exits, fails or says nothing within the time.
function announcedDevToolsAddress(
    browserProcess: ChildProcess,
    timeoutMilliseconds: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const outputStreams = outputStreamsOf(browserProcess);
        let output = "";
        const fail = (error: Error): void => {
            cleanUp();
            reject(error);
        };
        const timer = setTimeout(
            () => fail(new Error(`Chromium did not start within ${timeoutMilliseconds} ms`)),
            timeoutMilliseconds,
        );
        const onExit = (code: number | null): void =>
            fail(new Error(`Chromium exited during start-up (exit code ${code})`));
        const onError = (error: Error): void => fail(error);
        const onOutput = (chunk: Buffer): void => {
            if (output.length < OUTPUT_LIMIT) {
                output += chunk.toString();
            }
            const match = DEVTOOLS_ANNOUNCEMENT.exec(output);
            if (match === null || match[1] === undefined) {
                return;
            }
            cleanUp();
            resolve(match[1]);
        };
        function cleanUp(): void {
            clearTimeout(timer);
            for (const stream of outputStreams) {
                stream.off("data", onOutput);
                // Keep draining the browser's output so a full pipe can never block it.
                stream.resume();
            }
            browserProcess.off("exit", onExit);
            browserProcess.off("error", onError);
        }
        for (const stream of outputStreams) {
            stream.on("data", onOutput);
        }
        browserProcess.once("exit", onExit);
        browserProcess.once("error", onError);
    });
}

export async function launchChromium(
    executablePath: string,
    options: LaunchOptions = {},
): Promise<LaunchedChromium> {
    const userDataFolder = mkdtempSync(
        join(tmpdir(), options.profilePrefix ?? "chromium-profile-"),
    );
    const chosen = options.arguments ?? ISOLATED_CHROMIUM_ARGUMENTS;
    const flags = [
        ...chosen,
        ...ALWAYS_HEADLESS_AND_MUTED.filter(
            (flag) => !chosen.some((given) => given.startsWith(flag.split("=")[0] ?? flag)),
        ),
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataFolder}`,
        "about:blank",
    ];
    // 'detached' starts the browser as the leader of a new process group outside Windows.
    const browserProcess = spawn(executablePath, flags, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: OWN_PROCESS_GROUP,
    });
    const exited = new Promise<void>((resolve) => {
        if (hasExited(browserProcess)) {
            resolve();
        }
        browserProcess.once("exit", () => resolve());
        browserProcess.once("error", () => resolve());
    });

    let stopping: Promise<void> | undefined;
    const stop = (connection: CdpConnection | null): Promise<void> => {
        stopping ??= stopBrowser(browserProcess, exited, userDataFolder, connection);
        return stopping;
    };

    try {
        const webSocketUrl = await announcedDevToolsAddress(
            browserProcess,
            options.launchTimeoutMilliseconds ?? 30_000,
        );
        const connection = await CdpConnection.open(webSocketUrl, options);
        return {
            connection,
            browserProcess,
            webSocketUrl,
            userDataFolder,
            exited,
            stop: () => stop(connection),
        };
    } catch (error) {
        // Why the launch failed is the answer, and what clearing up after it left is added on.
        try {
            await stop(null);
        } catch (stopError) {
            throw new Error(`${messageOf(error)}; ${messageOf(stopError)}`, { cause: stopError });
        }
        throw error;
    }
}
