// Under load taskkill can report failure though it ended the whole tree, finding the browser already
// ending, and the browser's exit can take longer to be seen than the grace allows after taskkill has
// ended it. Neither is a stop that left anything behind, so neither may read as one. Only a taskkill
// that says something else went wrong leaves the stop to ask the browser to close.
import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import { launchChromium, type LaunchedChromium } from "@revisum/driver-cdp";
import { launchChromiumWithArguments } from "@revisum/driver-cdp/testing";
import { CLOSE_THE_BROWSER } from "#test-support/browser/TestCommand.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { FIXTURES } from "#test-support/repository.ts";

const ON_WINDOWS_ONLY = {
    skip: platform() === "win32" ? false : "taskkill exists only on Windows",
    timeout: 60_000,
};
const STAND_INS = join(FIXTURES, "chromium-stop");
const TASKKILL_THAT_REPORTS = join(STAND_INS, "taskkill-that-reports.cjs").replaceAll("\\", "/");
const NO_RUNNING_INSTANCE =
    "ERROR: The process with PID 1 (child process of PID 2) could not be terminated.\r\nReason: There is no running instance of the task.\r\n";
const ACCESS_DENIED = "ERROR: Access is denied.\r\n";
// Longer than the 4 s grace and 1 s forced wait for the browser's exit.
const SLOW_EXIT_MILLISECONDS = 6000;

type TaskkillStandIn = {
    readonly exitCode: number;
    readonly output?: string;
    readonly endsTheTree: boolean;
    readonly ranFile?: string;
};

const placeTaskkillIn = (folder: string): void => {
    const placed = join(folder, "taskkill.exe");
    try {
        linkSync(process.execPath, placed);
    } catch {
        copyFileSync(process.execPath, placed);
    }
};

// Runs an action with a taskkill on the PATH that answers as `standIn` says.
async function withStandInTaskkill<Answer>(
    standIn: TaskkillStandIn,
    action: () => Promise<Answer>,
): Promise<Answer> {
    const folder = mkdtempSync(join(tmpdir(), "stand-in-taskkill-"));
    placeTaskkillIn(folder);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = folder;
    process.env["NODE_OPTIONS"] = `--require "${TASKKILL_THAT_REPORTS}"`;
    process.env["STAND_IN_TASKKILL_EXIT_CODE"] = String(standIn.exitCode);
    process.env["STAND_IN_TASKKILL_OUTPUT"] = standIn.output ?? "";
    process.env["STAND_IN_TASKKILL_ENDS_THE_TREE"] = standIn.endsTheTree ? "yes" : "no";
    if (standIn.ranFile !== undefined) {
        process.env["STAND_IN_TASKKILL_RAN_FILE"] = standIn.ranFile;
    }
    try {
        return await action();
    } finally {
        process.env["PATH"] = originalPath;
        for (const name of [
            "NODE_OPTIONS",
            "STAND_IN_TASKKILL_EXIT_CODE",
            "STAND_IN_TASKKILL_OUTPUT",
            "STAND_IN_TASKKILL_ENDS_THE_TREE",
            "STAND_IN_TASKKILL_RAN_FILE",
        ]) {
            Reflect.deleteProperty(process.env, name);
        }
        rmSync(folder, { recursive: true, force: true, ["maxRetries"]: 5, retryDelay: 200 });
    }
}

const launchRealBrowser = (): Promise<LaunchedChromium> =>
    launchChromium(BROWSERS.chrome, { profilePrefix: "chromium-stop-judged-" });

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

describe("Using the Chromium launcher", () => {
    describe("given a browser on Windows", () => {
        describe("and a taskkill that ended its tree but exits 255, saying no running instance", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should count the tree ended and not ask the browser to close",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const launched = await launchRealBrowser();
                        const closesAsked = await withStandInTaskkill(
                            { exitCode: 255, output: NO_RUNNING_INSTANCE, endsTheTree: true },
                            () => stopCountingCloses(launched),
                        );
                        assert.equal(closesAsked, 0);
                    },
                );
            });
        });

        describe("and a taskkill that exits 255 saying access is denied", () => {
            describe("when it is stopped", () => {
                test("then it should still ask the browser to close", ON_WINDOWS_ONLY, async () => {
                    const launched = await launchRealBrowser();
                    const closesAsked = await withStandInTaskkill(
                        { exitCode: 255, output: ACCESS_DENIED, endsTheTree: false },
                        () => stopCountingCloses(launched),
                    );
                    assert.equal(closesAsked, 1);
                });
            });
        });

        describe("and a taskkill that succeeds, with the browser's exit slow to be seen", () => {
            describe("when it is stopped", () => {
                test(
                    "then it should resolve instead of naming the browser process as left",
                    ON_WINDOWS_ONLY,
                    async () => {
                        const folder = mkdtempSync(join(tmpdir(), "stand-in-late-browser-"));
                        const ranFile = join(folder, "taskkill-ran");
                        const launched = await launchChromiumWithArguments(process.execPath, {
                            arguments: [
                                join(STAND_INS, "browser-that-exits-late.cjs"),
                                ranFile,
                                String(SLOW_EXIT_MILLISECONDS),
                                "--headless",
                                "--mute-audio",
                            ],
                            profilePrefix: "chromium-stop-late-",
                        });
                        // Node's own signal would end the stand-in for good, which is not what is being shown: only
                        // the wait for an exit already on its way.
                        const kills = mock.method(launched.browserProcess, "kill", () => true);
                        try {
                            await withStandInTaskkill(
                                { exitCode: 0, endsTheTree: false, ranFile },
                                () => launched.stop(),
                            );
                        } finally {
                            kills.mock.restore();
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
});
