// When stopping a launched browser goes wrong. Stop always ends in time, even when ending the process tree
// wedges, and says what it could not do: a process left running or a folder left behind would otherwise go
// unseen until it fills the machine. The stand-in browsers in test/fixtures/tooling/chromium-stop are ordinary programs the
// launcher starts as it would a browser, so what is left is certain and belongs to this test.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { launchChromium, type LaunchedChromium } from "@revisum/driver-cdp";
import { launchChromiumWithArguments } from "@revisum/driver-cdp/testing";
import { BROWSERS } from "#test-support/browser/Browsers.ts";
import { endAtOnce, isRunning, listProcesses } from "#test-support/browser/harnesses/ProcessTree.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

const ON_WINDOWS_ONLY = {
    skip:
        platform() === "win32"
            ? false
            : "taskkill, and a working folder that cannot be removed, exist only on Windows",
    timeout: 60_000,
};
// Far past asking the browser to close, its grace period and forcing it, and well inside a test's timeout.
const STOP_BOUND_MILLISECONDS = 30_000;
const STILL_WAITING = "still waiting";
const FINISHED = "finished";
type Settling = typeof FINISHED | typeof STILL_WAITING;

const STAND_INS = join(FIXTURES, "tooling", "chromium-stop");
const LEAVES_A_PROCESS = "browser-that-leaves-a-process.cjs";
const EXITS_HOLDING_ITS_PROFILE = "browser-that-exits-holding-its-profile.cjs";

const removeFolder = (folder: string): void => {
    rmSync(folder, { recursive: true, force: true, ["maxRetries"]: 5, retryDelay: 200 });
};

const launchRealBrowser = (): Promise<LaunchedChromium> =>
    launchChromium(BROWSERS.chrome, { profilePrefix: "chromium-stop-test-" });

const browserIdOf = (launched: LaunchedChromium): number => {
    const { pid } = launched.browserProcess;
    assert.ok(pid !== undefined, "the browser process has an id");
    return pid;
};

// Crashpad handlers can outlive a browser, and are this test's own, found by the profile folder only
// this launch holds.
function endWhatIsLeftOf(launched: LaunchedChromium): void {
    for (const leftover of listProcesses()) {
        if (leftover.commandLine.includes(launched.userDataFolder)) {
            endAtOnce(leftover.processId);
        }
    }
    try {
        removeFolder(launched.userDataFolder);
    } catch {
        // A process just ended can hold a file a moment longer, and this folder is the system's to clear.
    }
}

// Whether the work finished inside the bound, whichever way it went: a test of a wedge has to outlast it.
async function settlesWithin(work: Promise<unknown>, milliseconds: number): Promise<Settling> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<Settling>((resolve) => {
        timer = setTimeout(() => {
            resolve(STILL_WAITING);
        }, milliseconds);
    });
    const finished = work.then<Settling, Settling>(
        () => FINISHED,
        () => FINISHED,
    );
    try {
        return await Promise.race([finished, bound]);
    } finally {
        clearTimeout(timer);
    }
}

const processIdIn = (file: string): number => Number(readFileSync(file, "utf8"));

function endProcessNamedIn(file: string): void {
    if (existsSync(file)) {
        endAtOnce(processIdIn(file));
    }
}

async function withPath<Answer>(path: string, action: () => Promise<Answer>): Promise<Answer> {
    const original = process.env["PATH"];
    process.env["PATH"] = path;
    try {
        return await action();
    } finally {
        process.env["PATH"] = original;
    }
}

// A hard link where the system allows one: a fresh copy of Node is a large write for no gain.
function placeTaskkillIn(folder: string): void {
    const placed = join(folder, "taskkill.exe");
    try {
        linkSync(process.execPath, placed);
    } catch {
        copyFileSync(process.execPath, placed);
    }
}

// Runs an action with a taskkill on the PATH that notes its id in the file and never answers. Node loads
// the wedge before it reads the arguments it would otherwise fail on.
async function withWedgedTaskkill<Answer>(
    folder: string,
    idFile: string,
    action: () => Promise<Answer>,
): Promise<Answer> {
    placeTaskkillIn(folder);
    const wedge = join(STAND_INS, "taskkill-that-wedges.cjs").replaceAll("\\", "/");
    process.env["NODE_OPTIONS"] = `--require "${wedge}"`;
    process.env["WEDGED_TASKKILL_ID_FILE"] = idFile;
    try {
        return await withPath(folder, action);
    } finally {
        Reflect.deleteProperty(process.env, "NODE_OPTIONS");
        Reflect.deleteProperty(process.env, "WEDGED_TASKKILL_ID_FILE");
    }
}

// Node, run with a stand-in browser as its script, takes every flag the launcher adds as that script's.
const launchStandIn = (program: string, idFile: string): Promise<LaunchedChromium> =>
    launchChromiumWithArguments(process.execPath, {
        arguments: [join(STAND_INS, program), idFile, "--headless", "--mute-audio"],
        profilePrefix: "chromium-stop-stand-in-",
    });

// Keeps a folder inside the profile from being removed, for as long as the process it returns runs.
function holdFolderOf(launched: LaunchedChromium): ChildProcess {
    const held = join(launched.userDataFolder, "held");
    mkdirSync(held);
    return spawn(process.execPath, ["-e", "setTimeout(() => {}, 90000)"], {
        cwd: held,
        stdio: "ignore",
        windowsHide: true,
    });
}

describe("Using the Chromium launcher", () => {
    describe("given a running browser on Windows", () => {
        describe("and a taskkill on the PATH that never answers", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should finish inside the bound, with the browser gone",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const folder = mkdtempSync(join(tmpdir(), "wedged-taskkill-"));
                        const idFile = join(folder, "taskkill-id");
                        const launched = await launchRealBrowser();
                        let stopping: Promise<void> | undefined;
                        try {
                            const settled = await withWedgedTaskkill(folder, idFile, () => {
                                stopping = launched.stop();
                                return settlesWithin(stopping, STOP_BOUND_MILLISECONDS);
                            });
                            assert.ok(existsSync(idFile), "the taskkill was started, and wedged");
                            assert.equal(settled, FINISHED);
                            assert.equal(isRunning(browserIdOf(launched)), false);
                        } finally {
                            endProcessNamedIn(idFile);
                            await stopping?.catch(() => undefined);
                            endWhatIsLeftOf(launched);
                            removeFolder(folder);
                        }
                    },
                );
            });
        });

        describe("and something else holding its profile folder", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should reject, naming the folder it could not remove",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const launched = await launchRealBrowser();
                        const holder = holdFolderOf(launched);
                        try {
                            await assert.rejects(launched.stop(), (error: Error) => {
                                assert.ok(existsSync(launched.userDataFolder), "the folder stayed");
                                assert.ok(
                                    error.message.includes(launched.userDataFolder),
                                    error.message,
                                );
                                return true;
                            });
                        } finally {
                            holder.kill();
                            endWhatIsLeftOf(launched);
                        }
                    },
                );
            });
        });
    });

    describe("given a browser on Windows with a process that outlives it", () => {
        describe("and the real taskkill on the PATH", () => {
            describe("when it is stopped", () => {
                test("then it should finish, with both gone", ON_WINDOWS_ONLY, async () => {
                    const folder = mkdtempSync(join(tmpdir(), "stand-in-browser-"));
                    const leftoverIdFile = join(folder, "leftover-id");
                    const launched = await launchStandIn(LEAVES_A_PROCESS, leftoverIdFile);
                    try {
                        await launched.stop();
                        assert.equal(isRunning(browserIdOf(launched)), false);
                        assert.equal(isRunning(processIdIn(leftoverIdFile)), false);
                        assert.equal(existsSync(launched.userDataFolder), false);
                    } finally {
                        endProcessNamedIn(leftoverIdFile);
                        endWhatIsLeftOf(launched);
                        removeFolder(folder);
                    }
                });
            });
        });

        describe("and a taskkill on the PATH that fails", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should reject, naming the process left and the taskkill that failed",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const folder = mkdtempSync(join(tmpdir(), "stand-in-browser-"));
                        const leftoverIdFile = join(folder, "leftover-id");
                        const launched = await launchStandIn(LEAVES_A_PROCESS, leftoverIdFile);
                        try {
                            // Node, handed /T as the script to run, finds no such script and exits with 1.
                            placeTaskkillIn(folder);
                            await withPath(folder, () =>
                                assert.rejects(launched.stop(), (error: Error) => {
                                    const leftoverId = processIdIn(leftoverIdFile);
                                    assert.ok(isRunning(leftoverId), "the process was left");
                                    assert.ok(
                                        error.message.includes(String(leftoverId)),
                                        error.message,
                                    );
                                    assert.match(error.message, /taskkill/);
                                    return true;
                                }),
                            );
                        } finally {
                            endProcessNamedIn(leftoverIdFile);
                            endWhatIsLeftOf(launched);
                            removeFolder(folder);
                        }
                    },
                );
            });
        });
    });

    // Cleaning up after a failed start goes through the same stop, which must not swallow why it failed.
    describe("given a browser that exits during start-up, leaving its profile folder held", () => {
        describe("when it is launched", () => {
            test(
                "then it should reject inside the bound, saying the browser exited",
                ON_WINDOWS_ONLY,
                async () => {
                    const folder = mkdtempSync(join(tmpdir(), "stand-in-browser-"));
                    const holderIdFile = join(folder, "holder-id");
                    const launching = launchStandIn(EXITS_HOLDING_ITS_PROFILE, holderIdFile);
                    try {
                        assert.equal(
                            await settlesWithin(launching, STOP_BOUND_MILLISECONDS),
                            FINISHED,
                        );
                        await assert.rejects(launching, /exited during start-up/);
                    } finally {
                        endProcessNamedIn(holderIdFile);
                        removeFolder(folder);
                    }
                },
            );
        });
    });
});
