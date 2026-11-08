// Starts a headless Chromium with a throwaway profile, waits for its DevTools address and
// connects. Stopping it ends the browser and removes the profile folder, always ends in time, and
// says what it could not do.
// Outside Windows the browser starts in a process group of its own, which its zygote, GPU,
// utility and renderer processes join. Those may outlive the browser process by a moment, so
// stopping waits until the whole group has exited, and ends what is left of it after a grace
// period. Only that group is ever signalled: it holds nothing the driver did not start. On
// Windows there are no such groups, so stopping ends the browser's process tree instead, and then waits
// for every process that names the profile folder to end, which is when Windows has let go of its files.
// The folder is removed once, after that wait: on Windows a folder that something still holds cannot be.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CLOSE_BROWSER } from "../connection/BrowserCommand.ts";
import { CdpConnection, type ConnectOptions } from "../connection/CdpConnection.ts";
import { PORT_RANDOMISATION_FEATURE, WEBRTC_UDP_OFF_FLAGS } from "./SessionEgressChromeFlags.ts";
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
    readonly processId: number;
    readonly webSocketUrl: string;
    readonly userDataFolder: string;
    // Settles once the browser process has ended, whatever ended it.
    readonly exited: Promise<void>;
    // Ends the browser's process tree on Windows, or elsewhere asks it to close and ends its process group.
    // Where the tree could not be ended it asks the browser to close there too, and forces it after a grace
    // period. Then it waits for what holds the profile folder to end, and removes the folder once. Always ends inside 30 seconds. Rejects naming
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
// How long a browser whose tree taskkill has ended is given for Node to see it exit, which under load
// can come many seconds after: the process has been told to end, so only this wait is left of it.
const EXIT_GRACE_AFTER_TREE_ENDED_MILLISECONDS = 12_000;
const EXIT_WHEN_FORCED_MILLISECONDS = 1_000;
// How long the browser's other processes on Windows are given to end, and so let go of the profile folder,
// once the browser has: ending a process tree only asks Windows to end each process, and one being torn down
// under load can take seconds to.
const WINDOWS_RELEASE_MILLISECONDS = 4_000;
const FOLDER_REMOVAL_MILLISECONDS = 3_000;

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

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

// Removes a profile folder, once, after stop has waited for what held it. What it could not remove, or null.
// Whatever holds it then is not the browser's, or outlived the wait, and is reported, not waited for.
async function folderLeftBehind(folder: string): Promise<string | null> {
    try {
        const removing = rm(folder, { recursive: true, force: true });
        return (await settledWithin(removing, FOLDER_REMOVAL_MILLISECONDS))
            ? null
            : `the folder ${folder}, still being removed after ${FOLDER_REMOVAL_MILLISECONDS} ms`;
    } catch (error) {
        return `the folder ${folder} (${messageOf(error)})`;
    }
}

const hasExited = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

const hasOwnProcessGroup = platform() !== "win32";
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
    if (!hasOwnProcessGroup || groupId === undefined) {
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

// Under load taskkill can end every child and then find the browser itself already ending, and exit
// non-zero for that alone. Each failure it reports is an "ERROR:" line with its "Reason:" under it, so
// the tree has ended when every reason says its process was already going. Its text is English only;
// another language reads as the tree not ended, and the stop asks the browser to close as well.
const TASK_ALREADY_ENDING = "There is no running instance of the task";

function hasOnlyEndingFailures(output: string): boolean {
    const lines = output.split(/\r?\n/);
    const failures = lines.filter((line) => line.startsWith("ERROR:"));
    const reasons = lines.filter((line) => line.startsWith("Reason:"));
    return (
        failures.length > 0 &&
        failures.length === reasons.length &&
        reasons.every((reason) => reason.includes(TASK_ALREADY_ENDING))
    );
}

const treeEnding = (code: number | null, output: string): TreeEnding =>
    code === 0 || hasOnlyEndingFailures(output)
        ? { hasEnded: true, whyNot: null }
        : treeNotEnded(`taskkill exited with code ${String(code)}`);

// The browser's crashpad handlers answer to no job object, and under load outlive it by half a minute.
// taskkill finds them through parent ids, so it has to run while the browser is alive: it replaces
// asking the browser to close, rather than following it. Node holds the process's handle until it has
// seen the exit, so until then the id can't belong to anything else. A taskkill that does not answer is
// ended: it is this stop's own, and nothing it could still do is worth waiting past the limit for.
function endWindowsProcessTree(browserProcess: ChildProcess): Promise<TreeEnding> {
    if (hasOwnProcessGroup || browserProcess.pid === undefined || hasExited(browserProcess)) {
        return Promise.resolve(TREE_NOT_TRIED);
    }
    return new Promise((resolve) => {
        const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(browserProcess.pid)], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const outputStreams = outputStreamsOf(taskkill);
        let output = "";
        for (const stream of outputStreams) {
            stream.on("data", (chunk: Buffer) => {
                if (output.length < OUTPUT_LIMIT) {
                    output += chunk.toString();
                }
            });
        }
        const limit = setTimeout(() => {
            taskkill.kill();
            for (const stream of outputStreams) {
                stream.destroy();
            }
            taskkill.unref();
            resolve(
                treeNotEnded(`taskkill did not answer within ${TASKKILL_LIMIT_MILLISECONDS} ms`),
            );
        }, TASKKILL_LIMIT_MILLISECONDS);
        // 'close', not 'exit': what it reported is read once its output has ended.
        taskkill.once("close", (code) => {
            clearTimeout(limit);
            resolve(treeEnding(code, output));
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
    graceMilliseconds: number,
): Promise<boolean> {
    const force = setTimeout(() => {
        browserProcess.kill();
    }, FORCE_AFTER_MILLISECONDS);
    const hasExitedByItself = await settledWithin(exited, graceMilliseconds);
    clearTimeout(force);
    if (hasExitedByItself) {
        return true;
    }
    browserProcess.kill();
    return settledWithin(exited, EXIT_WHEN_FORCED_MILLISECONDS);
}

// Which of the browser's other processes run on, on Windows, waiting for them to end first, as they hold the
// profile folder until they have. Ending the tree only asks Windows to end them, so this waits even when that
// worked. What stop waits for on every platform is a grace period past the browser's exit, so what still runs
// after one is what counts as left.
async function windowsProcessesLeftBehind(
    folder: string,
    browserProcess: ChildProcess,
    stopStartedAt: number,
): Promise<readonly string[]> {
    if (hasOwnProcessGroup || browserProcess.pid === undefined) {
        return [];
    }
    try {
        return (
            await windowsProcessesLeft(
                folder,
                { processId: browserProcess.pid, stopStartedAt },
                WINDOWS_RELEASE_MILLISECONDS,
            )
        ).map((processId) => `the process ${processId}`);
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
    const stopStartedAt = Date.now();
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
        ...((await hasBrowserExitedInTime(
            browserProcess,
            exited,
            ending.hasEnded ? EXIT_GRACE_AFTER_TREE_ENDED_MILLISECONDS : EXIT_GRACE_MILLISECONDS,
        ))
            ? []
            : [`the browser process ${String(processId)}`]),
        ...((await endProcessGroup(processId)) ? [] : [`the process group ${String(processId)}`]),
        ...(await windowsProcessesLeftBehind(userDataFolder, browserProcess, stopStartedAt)),
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

// A process that has answered has a process id: Node leaves it unset only for one that never started.
function processIdOf(browserProcess: ChildProcess): number {
    const processId = browserProcess.pid;
    if (processId === undefined) {
        throw new Error("Chromium answered without a process id");
    }
    return processId;
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
        detached: hasOwnProcessGroup,
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
        const processId = processIdOf(browserProcess);
        const connection = await CdpConnection.open(webSocketUrl, options);
        return {
            connection,
            browserProcess,
            processId,
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
