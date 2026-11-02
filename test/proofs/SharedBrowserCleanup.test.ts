// A test process that holds a shared browser, ended or killed, leaves no browser or profile behind.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { profileFolderOf } from "#test-support/browser/BrowserWatchdog.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { isRunning } from "#test-support/process-tree.ts";

const HOLDER = fileURLToPath(new URL("../support/browser/HoldSharedBrowser.ts", import.meta.url));
const CLEANED_UP_WITHIN_MILLISECONDS = 30_000;
const CLEAN_UP_POLL_MILLISECONDS = 50;

type HeldBrowser = { readonly processId: number; readonly webSocketUrl: string };

const startHolder = (mode: string): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [HOLDER, BROWSERS.chrome, mode], { windowsHide: true });

async function browserHeldBy(holder: ChildProcessWithoutNullStreams): Promise<HeldBrowser> {
    let output = "";
    for await (const chunk of holder.stdout) {
        output += String(chunk);
        if (output.includes("\n")) {
            break;
        }
    }
    const held: unknown = JSON.parse(output);
    assert.ok(
        typeof held === "object" &&
            held !== null &&
            "processId" in held &&
            typeof held.processId === "number" &&
            "webSocketUrl" in held &&
            typeof held.webSocketUrl === "string",
        output,
    );
    return { processId: held.processId, webSocketUrl: held.webSocketUrl };
}

const isCleanedUp = (browser: HeldBrowser): boolean =>
    !isRunning(browser.processId) && profileFolderOf(browser.webSocketUrl) === null;

async function assertCleanedUp(browser: HeldBrowser): Promise<void> {
    const giveUpAt = Date.now() + CLEANED_UP_WITHIN_MILLISECONDS;
    while (!isCleanedUp(browser) && Date.now() < giveUpAt) {
        await pause(CLEAN_UP_POLL_MILLISECONDS);
    }
    assert.equal(isRunning(browser.processId), false, "the browser has ended");
    assert.equal(profileFolderOf(browser.webSocketUrl), null, "its profile has gone");
}

describe("Using the shared browsers of a test process", () => {
    describe("given a process holding a browser", () => {
        describe("when the process is killed", () => {
            test("then it should leave no browser or profile behind", async () => {
                const holder = startHolder("hold");
                const exited = once(holder, "exit");
                const browser = await browserHeldBy(holder);
                const folder = profileFolderOf(browser.webSocketUrl);
                assert.ok(folder !== null && existsSync(folder), "the profile can be found");
                assert.ok(isRunning(browser.processId));
                holder.kill("SIGKILL");
                await exited;
                await assertCleanedUp(browser);
            });
        });

        describe("when the process stops its browsers", () => {
            test("then it should exit by itself and leave no browser or profile behind", async () => {
                const holder = startHolder("stop");
                const exited = once(holder, "exit");
                const browser = await browserHeldBy(holder);
                const exit: readonly unknown[] = await exited;
                assert.equal(exit[0], 0);
                await assertCleanedUp(browser);
            });
        });
    });
});
