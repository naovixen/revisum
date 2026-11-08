// A shared browser that a session failed to open or close on can't be trusted with the next session,
// even once it looks clean again, so the next session must get a new one. The browser is real, and so
// are both failures: an egress that won't start fails the open, and a browser context the session
// doesn't own keeps its close waiting until it gives up.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { CdpConnection, type SharedBrowser } from "@revisum/driver-cdp";
import { CREATE_A_CONTEXT, LIST_CONTEXTS } from "#test-support/browser/TestCommand.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { createBrowserDriver } from "#test-support/browser/CreateBrowserDriver.ts";
import {
    shareBrowserInThisFile,
    sharedBrowserFor,
} from "#test-support/browser/ShareBrowserInThisFile.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.HeadlessShell;
const EXECUTABLE_PATH = BROWSERS.chromeHeadlessShell;
const CONTROL_TIMEOUT_MILLISECONDS = 5_000;
const CONTEXT_POLL_MILLISECONDS = 20;
const CONTEXT_GONE_WITHIN_MILLISECONDS = 10_000;
const KEPT_THE_CONTEXT = /kept the session's browser context/;
const WHY_THE_EGRESS_FAILED = "no port for the proxy";

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(5_000);
});
after(async () => {
    await harness.close();
});

const browserForTheNextSession = (): Promise<SharedBrowser> =>
    sharedBrowserFor({
        executablePath: EXECUTABLE_PATH,
        locale: harness.target(TARGET).locale,
    });

const driverThroughARealEgress = () => createBrowserDriver({ executablePath: EXECUTABLE_PATH });

const driverWhoseEgressWontStart = () =>
    createBrowserDriver({
        executablePath: EXECUTABLE_PATH,
        egress: () => Promise.reject(new Error(WHY_THE_EGRESS_FAILED)),
    });

async function openAndCloseASession(): Promise<number> {
    const opened = await driverThroughARealEgress().open(
        harness.target(TARGET),
        harness.environment(),
    );
    assert.ok(opened.ok, JSON.stringify(opened));
    const { processId } = opened.value;
    const navigated = await opened.value.navigate(harness.url("/"), scriptsEnabled);
    assert.ok(navigated.ok, JSON.stringify(navigated));
    await opened.value.close();
    return processId;
}

const openControlConnection = (browser: SharedBrowser): Promise<CdpConnection> =>
    CdpConnection.open(browser.webSocketUrl, {
        connectTimeoutMilliseconds: CONTROL_TIMEOUT_MILLISECONDS,
        commandTimeoutMilliseconds: CONTROL_TIMEOUT_MILLISECONDS,
    });

async function waitUntilNoContextIsLeft(browser: SharedBrowser): Promise<void> {
    const control = await openControlConnection(browser);
    try {
        const giveUpAt = Date.now() + CONTEXT_GONE_WITHIN_MILLISECONDS;
        let left = 1;
        while (left > 0 && Date.now() < giveUpAt) {
            left = (await control.ask(undefined, LIST_CONTEXTS, {})).length;
            await pause(CONTEXT_POLL_MILLISECONDS);
        }
        assert.equal(left, 0, "the browser still holds a context");
    } finally {
        control.close();
    }
}

describe("Using a browser shared by the sessions of a test file", () => {
    describe("given a session that closed normally", () => {
        describe("when the next session asks for a browser", () => {
            let closedOn: number;
            let nextProcessId: number;
            before(async () => {
                closedOn = await openAndCloseASession();
                nextProcessId = await openAndCloseASession();
            });

            test("then it should give it the same browser", () => {
                assert.equal(nextProcessId, closedOn);
            });
        });
    });

    describe("given a session that failed to open", () => {
        describe("when the next session asks for a browser", () => {
            let usedBefore: SharedBrowser;
            let openFailure: string;
            let replacement: SharedBrowser;
            let nextProcessId: number;
            before(async () => {
                usedBefore = await browserForTheNextSession();
                const opened = await driverWhoseEgressWontStart().open(
                    harness.target(TARGET),
                    harness.environment(),
                );
                assert.ok(!opened.ok, "the session opened with no egress");
                openFailure = opened.error.detail;
                replacement = await browserForTheNextSession();
                nextProcessId = await openAndCloseASession();
            });

            test("then it should have failed the open for the reason forced", () => {
                assert.match(openFailure, new RegExp(WHY_THE_EGRESS_FAILED));
            });

            test("then it should launch a new browser", () => {
                assert.notEqual(replacement.processId, usedBefore.processId);
            });

            test("then it should have ended the old browser", () => {
                assert.equal(usedBefore.isAlive(), false);
            });

            test("then it should run the session on the new browser", () => {
                assert.equal(nextProcessId, replacement.processId);
            });
        });
    });

    describe("given a session whose close failed", () => {
        describe("and the browser looks clean again before the next session", () => {
            describe("when the next session asks for a browser", () => {
                let usedBefore: SharedBrowser;
                let closeFailure: unknown;
                let replacement: SharedBrowser;
                let nextProcessId: number;
                before(async () => {
                    usedBefore = await browserForTheNextSession();
                    const opened = await driverThroughARealEgress().open(
                        harness.target(TARGET),
                        harness.environment(),
                    );
                    assert.ok(opened.ok, JSON.stringify(opened));
                    const control = await openControlConnection(usedBefore);
                    await control.ask(undefined, CREATE_A_CONTEXT, {
                        disposeOnDetach: true,
                    });
                    closeFailure = (await opened.value.close()).closeFailure;
                    control.close();
                    await waitUntilNoContextIsLeft(usedBefore);
                    replacement = await browserForTheNextSession();
                    nextProcessId = await openAndCloseASession();
                });

                test("then it should have failed the close for the reason forced", () => {
                    assert.ok(typeof closeFailure === "string", String(closeFailure));
                    assert.match(closeFailure, KEPT_THE_CONTEXT);
                });

                test("then it should launch a new browser", () => {
                    assert.notEqual(replacement.processId, usedBefore.processId);
                });

                test("then it should have ended the old browser", () => {
                    assert.equal(usedBefore.isAlive(), false);
                });

                test("then it should run the session on the new browser", () => {
                    assert.equal(nextProcessId, replacement.processId);
                });
            });
        });
    });
});
