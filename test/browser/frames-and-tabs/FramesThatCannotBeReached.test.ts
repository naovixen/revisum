// Whether a frame can be reached is asked of the browser when a step enters it. Only a frame whose
// document runs in another renderer process is a frame this driver cannot reach. A page a dialog holds,
// or a command that ran out of time, says nothing about the frame, so neither may read as a frame the
// driver cannot reach.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { startRelayedDriver, type RelayedDriver } from "#test-support/browser/driver/RelayedDriver.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import type { ReplyChange } from "#test-support/browser/driver/CdpRelay.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { failureCode, locatorOf } from "#test-support/session-contract/SessionUnderTest.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 2000;
const TARGET = BrowserTarget.Chrome;
const PAGE = "/frames.html";
const CART_FRAME = { by: "testId", testId: "cart-frame" };

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Frames</title></head><body>
      <main><iframe title="Cart" data-testid="cart-frame" srcdoc="<p>Cart</p>"></iframe></main>
    </body></html>`,
        }),
    ],
]);

const OPEN_DIALOG_IN_THE_PAGE: ReplyChange = {
    runInThePageFirst: `alert("held")`,
};
// The text the connection fails a command with when no answer comes in time.
const COMMAND_TIMED_OUT: ReplyChange = { refusal: "timeout after 15000 ms" };

describe("Using the real browser driver", () => {
    let harness: CapabilityHarness;
    let relayed: RelayedDriver;

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });
    beforeEach(async () => {
        relayed = await startRelayedDriver();
    });
    afterEach(async () => {
        await relayed.relay.close();
    });

    // The driver reads the top document through a world of its own first, so the first frame it asks
    // for a world in is the top document; the next is the iframe's.
    const tamperingWithTheFramesWorld = (change: ReplyChange): void => {
        let topFrame: unknown;
        relayed.relay.tamperWith({
            method: "Page.createIsolatedWorld",
            applies: ({ parameters }) => {
                topFrame ??= parameters["frameId"];
                return parameters["frameId"] !== topFrame;
            },
            change,
        });
    };

    const onOpenSession = async (use: (session: DriverSession) => Promise<string>) => {
        const opened = await relayed.driver.open(harness.target(TARGET), harness.environment());
        assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
        const session = opened.value;
        try {
            assert.ok(
                (await session.navigate(harness.url(PAGE), scriptsEnabled)).ok,
                `${PAGE} loads`,
            );
            return await use(session);
        } finally {
            await session.close().catch(() => undefined);
        }
    };

    const failingFrames = [
        { name: "a dialog holds the page", change: OPEN_DIALOG_IN_THE_PAGE, code: "dialog-open" },
        { name: "the command runs out of time", change: COMMAND_TIMED_OUT, code: "timeout" },
    ];

    for (const { name, change, code } of failingFrames) {
        describe(`given ${name} as a step enters a frame`, () => {
            describe("when it asks for the frame", () => {
                test(`then it should fail with ${code}, not as a frame the driver cannot reach`, async () => {
                    const answer = await onOpenSession(async (session) => {
                        tamperingWithTheFramesWorld(change);
                        return failureCode(await session.frame(locatorOf(CART_FRAME)));
                    });
                    assert.equal(answer, code);
                });
            });
        });
    }

    describe("given a frame the browser can reach", () => {
        describe("when a step asks for it", () => {
            test("then it should enter the frame", async () => {
                const entered = await onOpenSession(async (session) => {
                    const frame = await session.frame(locatorOf(CART_FRAME));
                    assert.ok(frame.ok, JSON.stringify(frame));
                    return "entered";
                });
                assert.equal(entered, "entered");
            });
        });
    });
});
