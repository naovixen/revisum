// A popup is held back and closed. A popup that could not be closed may still run, so the session's
// close says so, and the list of what failed to clean up must wait for the close's answer to know.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, role } from "#test-support/browser/RawPlan.ts";
import {
    startRelayedDriverOnItsOwnBrowser,
    type RelayedDriverOnItsOwnBrowser,
} from "#test-support/browser/RelayedDriver.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";

const STEP_TIMEOUT_MILLISECONDS = 4000;
const TARGET = BrowserTarget.Chrome;
const PAGE = "/opener.html";
const BUTTON = "Open a popup";
const WHY_THE_BROWSER_REFUSED = "the browser would not close the target";

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            // A popup with no address asks for nothing, so the driver closes it only after its wait.
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opener</title></head><body>
      <main><button type="button" onclick="window.open('', 'held', 'width=300,height=200')">${BUTTON}</button></main>
    </body></html>`,
        }),
    ],
]);

describe("Using a session on a page that opens a popup", () => {
    let harness: CapabilityHarness;
    let relayed: RelayedDriverOnItsOwnBrowser;

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });
    beforeEach(async () => {
        relayed = await startRelayedDriverOnItsOwnBrowser();
    });
    afterEach(async () => {
        await relayed.close();
    });

    const closeAfterOpeningThePopup = async () => {
        const opened = await relayed.driver.open(harness.target(TARGET), harness.environment());
        assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
        const session = opened.value;
        assert.ok((await session.navigate(harness.url(PAGE), scriptsEnabled)).ok, `${PAGE} loads`);
        await session.act(harness.actionStep(click(role("button", BUTTON))), allowEveryAction);
        return session.close();
    };

    describe("given a held popup the browser refuses to close", () => {
        describe("when the session closes", () => {
            test("then it should report the popup that could not be closed", async () => {
                relayed.relay.tamperWith({
                    method: "Target.closeTarget",
                    change: { refusal: WHY_THE_BROWSER_REFUSED },
                });
                const closed = await closeAfterOpeningThePopup();
                const failureText = closed.closeFailure ?? "";
                assert.match(failureText, /popup/i, JSON.stringify(closed));
                assert.ok(failureText.includes(WHY_THE_BROWSER_REFUSED), failureText);
            });
        });
    });

    describe("given a held popup the browser closes", () => {
        describe("when the session closes", () => {
            test("then it should report no failure", async () => {
                const closed = await closeAfterOpeningThePopup();
                assert.equal(closed.closeFailure, null, JSON.stringify(closed));
            });
        });
    });
});
