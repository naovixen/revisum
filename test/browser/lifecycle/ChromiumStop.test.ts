// What stopping a launched browser leaves behind. On Windows a browser's crashpad handlers answer to no
// job object and can outlive it by half a minute under load, holding its profile folder, so stop ends the
// browser's whole tree, and has to go on working when it can't.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { launchChromium, type LaunchedChromium } from "@revisum/driver-cdp";
import { CLOSE_THE_BROWSER } from "#test-support/browser/TestCommand.ts";
import { BROWSERS } from "#test-support/browser/Browsers.ts";
import {
    endAtOnce,
    isRunning,
    listProcesses,
    processTree,
    stillRunning,
    type RunningProcess,
} from "#test-support/browser/harnesses/ProcessTree.ts";

const isWindows = platform() === "win32";
const ON_WINDOWS_ONLY = {
    skip: isWindows
        ? false
        : "taskkill and crashpad's way of outliving the browser exist only on Windows; elsewhere stop ends a process group",
    timeout: 60_000,
};
const EVERYWHERE = { timeout: 60_000 };
const CRASHPAD_SWITCH = "--type=crashpad-handler";

const launch = (): Promise<LaunchedChromium> =>
    launchChromium(BROWSERS.chrome, { profilePrefix: "chromium-stop-test-" });

const browserIdOf = (launched: LaunchedChromium): number => {
    const { pid } = launched.browserProcess;
    assert.ok(pid !== undefined, "the browser process has an id");
    return pid;
};

// A process ended by force has its exit code at once, but Windows can list it for a second or two more
// while the system tears it down, as it does a GPU process. It runs nothing by then, so only what still
// runs counts.
const runningProcesses = (): readonly RunningProcess[] =>
    listProcesses().filter((candidate) => isRunning(candidate.processId));

const childrenOf = (browserId: number): readonly string[] =>
    runningProcesses()
        .filter((candidate) => candidate.parentProcessId === browserId)
        .map((candidate) => candidate.commandLine);

const holdersOfProfile = (folder: string): readonly RunningProcess[] =>
    runningProcesses().filter((candidate) => candidate.commandLine.includes(folder));

// Crashpad handlers can outlive a browser the test ended by a way other than stop. They are this
// test's own, found by the profile folder only this launch holds.
function endWhatIsLeftOf(launched: LaunchedChromium): void {
    for (const leftover of holdersOfProfile(launched.userDataFolder)) {
        endAtOnce(leftover.processId);
    }
    try {
        rmSync(launched.userDataFolder, {
            recursive: true,
            force: true,
            ["maxRetries"]: 5,
            retryDelay: 200,
        });
    } catch {
        // A process just ended can hold a file a moment longer, and this folder is the system's to clear.
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

// Stops the browser, and says how many times that asked it to close.
async function stopCountingCloses(launched: LaunchedChromium): Promise<number> {
    const asks = mock.method(launched.connection, "ask");
    try {
        await launched.stop();
        return asks.mock.calls.filter(
            (call) => call.arguments[1].method === CLOSE_THE_BROWSER.method,
        ).length;
    } finally {
        asks.mock.restore();
    }
}

// A hard link where the system allows one: a fresh copy of Node is a large write for no gain.
function placeProgramAs(folder: string, name: string): void {
    const placed = join(folder, name);
    try {
        linkSync(process.execPath, placed);
    } catch {
        copyFileSync(process.execPath, placed);
    }
}

describe("Using the Chromium launcher", () => {
    describe("given a running browser on Windows", () => {
        describe("when it is stopped", () => {
            let launched: LaunchedChromium;
            let browserId: number;
            let handlersBeforeStop: readonly RunningProcess[];
            let childrenBeforeStop: readonly string[];
            let closesAsked: number;

            before(async () => {
                if (!isWindows) {
                    return;
                }
                launched = await launch();
                browserId = browserIdOf(launched);
                handlersBeforeStop = holdersOfProfile(launched.userDataFolder).filter((holder) =>
                    holder.commandLine.includes(CRASHPAD_SWITCH),
                );
                childrenBeforeStop = childrenOf(browserId);
                closesAsked = await stopCountingCloses(launched);
            });
            after(() => {
                if (isWindows) {
                    endWhatIsLeftOf(launched);
                }
            });

            test(
                "then it should have ended the processes below the browser",
                ON_WINDOWS_ONLY,
                () => {
                    assert.ok(
                        childrenBeforeStop.length > 0,
                        "the browser had started other processes",
                    );
                    assert.deepEqual(childrenOf(browserId), []);
                },
            );

            test(
                "then it should leave no crashpad handler holding the profile folder",
                ON_WINDOWS_ONLY,
                () => {
                    assert.ok(handlersBeforeStop.length > 0, "the browser had a crashpad handler");
                    assert.deepEqual(stillRunning(handlersBeforeStop), []);
                    assert.deepEqual(holdersOfProfile(launched.userDataFolder), []);
                },
            );

            test("then it should have removed the profile folder", ON_WINDOWS_ONLY, () => {
                assert.equal(existsSync(launched.userDataFolder), false);
            });

            test(
                "then it should have ended the browser without asking it to close",
                ON_WINDOWS_ONLY,
                () => {
                    assert.equal(isRunning(browserId), false);
                    assert.equal(closesAsked, 0);
                },
            );
        });

        describe("and no taskkill on the PATH", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should still end the browser by asking it to close",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const launched = await launch();
                        try {
                            const closesAsked = await withPath("", () => {
                                const { error } = spawnSync("taskkill", ["/?"], {
                                    windowsHide: true,
                                });
                                assert.ok(error !== undefined && "code" in error);
                                assert.equal(error.code, "ENOENT", "this PATH holds no taskkill");
                                return stopCountingCloses(launched);
                            });
                            assert.equal(closesAsked, 1);
                            assert.equal(isRunning(browserIdOf(launched)), false);
                        } finally {
                            endWhatIsLeftOf(launched);
                        }
                    },
                );
            });
        });

        describe("and a taskkill on the PATH that fails", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should still end the browser by asking it to close",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const folder = mkdtempSync(join(tmpdir(), "failing-taskkill-"));
                        const launched = await launch();
                        try {
                            // Node, handed /T as the script to run, finds no such script and exits with 1.
                            placeProgramAs(folder, "taskkill.exe");
                            const closesAsked = await withPath(folder, () => {
                                const refused = spawnSync("taskkill", ["/T", "/F"], {
                                    windowsHide: true,
                                });
                                assert.equal(refused.status, 1, "this taskkill fails");
                                return stopCountingCloses(launched);
                            });
                            assert.equal(closesAsked, 1);
                            assert.equal(isRunning(browserIdOf(launched)), false);
                        } finally {
                            endWhatIsLeftOf(launched);
                            rmSync(folder, {
                                recursive: true,
                                force: true,
                                ["maxRetries"]: 5,
                                retryDelay: 200,
                            });
                        }
                    },
                );
            });
        });
    });

    describe("given a browser process that has just been ended", () => {
        describe("when it is stopped at once", () => {
            test("then it should finish, with the browser gone", EVERYWHERE, async () => {
                const launched = await launch();
                try {
                    endAtOnce(browserIdOf(launched));
                    await launched.stop();
                    assert.equal(isRunning(browserIdOf(launched)), false);
                } finally {
                    endWhatIsLeftOf(launched);
                }
            });
        });
    });

    describe("given a browser that has just been asked to close", () => {
        describe("when it is stopped at once", () => {
            test("then it should finish, with the browser gone", EVERYWHERE, async () => {
                const launched = await launch();
                try {
                    const asked = launched.connection
                        .ask(undefined, CLOSE_THE_BROWSER, {}, 5_000)
                        .catch(() => undefined);
                    await launched.stop();
                    await asked;
                    assert.equal(isRunning(browserIdOf(launched)), false);
                } finally {
                    endWhatIsLeftOf(launched);
                }
            });
        });
    });

    describe("given a running browser", () => {
        describe("when it is stopped twice at once", () => {
            test("then it should finish both, with every process gone", EVERYWHERE, async () => {
                const launched = await launch();
                const tree = processTree(browserIdOf(launched));
                try {
                    assert.ok(tree.length > 1, "the browser had started other processes");
                    await Promise.all([launched.stop(), launched.stop()]);
                    assert.deepEqual(stillRunning(tree), []);
                    assert.equal(existsSync(launched.userDataFolder), false);
                } finally {
                    endWhatIsLeftOf(launched);
                }
            });
        });

        describe("when it is stopped again after it has stopped", () => {
            test("then it should finish the second too", EVERYWHERE, async () => {
                const launched = await launch();
                try {
                    await launched.stop();
                    await launched.stop();
                    assert.equal(isRunning(browserIdOf(launched)), false);
                } finally {
                    endWhatIsLeftOf(launched);
                }
            });
        });
    });
});
