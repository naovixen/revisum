// What arrives on the browser's socket is outside input. An event of the wrong shape says nothing the
// driver can act on, so it counts against the run like a refused decision, and text that is no message of
// the protocol ends the connection. Neither throws out of the socket's handler. Nor does a session's close
// stop at its first failure: each part closes, and the rejection names all that went wrong.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { startRelayedDriver, type RelayedDriver } from "#test-support/browser/RelayedDriver.ts";
import { realEgressSource } from "#test-support/browser/SessionEgressForTest.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 1000;
const BUTTON = "save";
const PAGE = "/page.html";
const WHAT_A_LANGUAGE_ERROR_SAYS = /Cannot read|is not a function|is not iterable|TypeError/;
const WHY_THE_EGRESS_WOULD_NOT_CLOSE = "the egress would not close";
const WHY_THE_RELEASE_WAS_REFUSED = "Internal error: the release was refused";

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <main><button type="button" data-testid="${BUTTON}">Save</button></main>
    </body></html>`,
        }),
    ],
]);

const MALFORMED_EVENTS = [
    { name: "a dialog's opening with no message", method: "Page.javascriptDialogOpening" },
    { name: "a dialog's closing with no result", method: "Page.javascriptDialogClosed" },
    { name: "a navigation with no frame", method: "Page.frameNavigated" },
    { name: "a request's sending with no request", method: "Network.requestWillBeSent" },
    { name: "a response's arrival with no response", method: "Network.responseReceived" },
];

const TEXTS_THAT_ARE_NO_MESSAGE = [
    { name: "text that is not JSON", text: "this is no message" },
    { name: "JSON that is a list", text: "[1, 2, 3]" },
    { name: "an object with neither an id nor a method", text: `{"params": {}}` },
];

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

    const onOpenSession = async <Value>(
        use: (session: DriverSession) => Promise<Value>,
    ): Promise<Value> => {
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
            await relayed.relay.close();
        }
    };

    const clickTheButton = (session: DriverSession) =>
        session.act(harness.actionStep(click(testId(BUTTON))), allowEveryAction);

    for (const { name, method } of MALFORMED_EVENTS) {
        describe(`given the browser sends ${name}`, () => {
            describe("when a plan clicks a button afterwards", () => {
                test("then it should hold it as a refusal, and fail the step saying the driver could not read it", async () => {
                    const { acted, refusals } = await onOpenSession(async (session) => {
                        relayed.relay.sendEvent(method, { unexpected: true });
                        // Answered after the event, on the same socket, so the driver has heard it.
                        await session.probe(harness.locator(testId(BUTTON)), null);
                        return {
                            acted: await clickTheButton(session),
                            refusals: session.refusedRequestDecisions(),
                        };
                    });
                    assert.ok(!acted.ok, "the step fails");
                    assert.equal(acted.error.code, "not-actionable");
                    assert.match(acted.error.detail, /could not read what the browser said/);
                    assert.doesNotMatch(acted.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
                    assert.ok(refusals.length > 0, "the session holds it");
                });
            });
        });
    }

    describe("given the browser sends a crash with no target, on no session", () => {
        describe("when a plan clicks a button afterwards", () => {
            test("then it should fail the step saying the driver could not read it", async () => {
                const acted = await onOpenSession(async (session) => {
                    relayed.relay.sendBrowserEvent("Target.targetCrashed", { unexpected: true });
                    await session.probe(harness.locator(testId(BUTTON)), null);
                    return clickTheButton(session);
                });
                assert.ok(!acted.ok, "the step fails");
                assert.match(acted.error.detail, /could not read what the browser said/);
            });
        });
    });

    describe("given the browser sends a press's report with no payload, as the press is sent", () => {
        describe("when a plan clicks a button", () => {
            test("then it should fail the step saying the driver could not read it", async () => {
                const acted = await onOpenSession(async (session) => {
                    relayed.relay.tamperWith({
                        method: "Input.dispatchMouseEvent",
                        applies: ({ parameters }) => {
                            if (parameters["type"] === "mousePressed") {
                                relayed.relay.sendEvent("Runtime.bindingCalled", {
                                    unexpected: true,
                                });
                            }
                            return false;
                        },
                        change: { refusal: "never given" },
                    });
                    return clickTheButton(session);
                });
                assert.ok(!acted.ok, "the step fails");
                assert.match(acted.error.detail, /could not read what the browser said/);
            });
        });
    });

    describe("given the browser sends nothing malformed", () => {
        describe("when a plan clicks a button", () => {
            test("then it should pass the step, with nothing held as a refusal", async () => {
                const { acted, refusals } = await onOpenSession(async (session) => ({
                    acted: await clickTheButton(session),
                    refusals: session.refusedRequestDecisions(),
                }));
                assert.deepEqual({ ok: acted.ok, refusals }, { ok: true, refusals: [] });
            });
        });
    });

    for (const { name, text } of TEXTS_THAT_ARE_NO_MESSAGE) {
        describe(`given the browser's socket carries ${name}`, () => {
            describe("when a plan reads the page and then clicks a button", () => {
                test("then it should read nothing, fail the step as target-crashed and see the session as dead", async () => {
                    const { count, acted, isDead } = await onOpenSession(async (session) => {
                        relayed.relay.sendText(text);
                        const { count: read } = await session.probe(
                            harness.locator(testId(BUTTON)),
                            null,
                        );
                        return {
                            count: read,
                            acted: await clickTheButton(session),
                            isDead: session.crashed(),
                        };
                    });
                    assert.deepEqual(
                        {
                            count,
                            code: acted.ok ? "acted" : acted.error.code,
                            isDead,
                        },
                        { count: "page-unreadable", code: "target-crashed", isDead: true },
                    );
                });
            });
        });
    }

    describe("given two parts of a session that each fail to close", () => {
        describe("when the session closes", () => {
            test("then it should reject naming both, having closed each", async () => {
                let wasEgressAskedToClose = false;
                const failing = await startRelayedDriver(undefined, async (allowedOrigins) => {
                    const egress = await realEgressSource(allowedOrigins);
                    return {
                        ...egress,
                        close: async () => {
                            wasEgressAskedToClose = true;
                            await egress.close();
                            throw new Error(WHY_THE_EGRESS_WOULD_NOT_CLOSE);
                        },
                    };
                });
                const opened = await failing.driver.open(
                    harness.target(TARGET),
                    harness.environment(),
                );
                assert.ok(opened.ok, JSON.stringify(opened));
                const session = opened.value;
                failing.relay.tamperWith({
                    method: "Runtime.releaseObject",
                    change: { refusal: WHY_THE_RELEASE_WAS_REFUSED },
                });
                try {
                    assert.ok((await session.navigate(harness.url(PAGE), scriptsEnabled)).ok);
                    assert.ok((await clickTheButton(session)).ok);
                    const closing = await session.close().then(
                        () => "closed",
                        (error: unknown) => String(error),
                    );
                    assert.ok(wasEgressAskedToClose, "the egress was asked to close");
                    assert.match(closing, /the release was refused/);
                    assert.match(closing, /the egress would not close/);
                } finally {
                    await failing.relay.close();
                }
            });
        });
    });

    describe("given one part of a session that fails to close", () => {
        describe("when the session closes", () => {
            test("then it should reject with that failure as it is", async () => {
                const failing = await startRelayedDriver(undefined, async (allowedOrigins) => {
                    const egress = await realEgressSource(allowedOrigins);
                    return {
                        ...egress,
                        close: async () => {
                            await egress.close();
                            throw new Error(WHY_THE_EGRESS_WOULD_NOT_CLOSE);
                        },
                    };
                });
                const opened = await failing.driver.open(
                    harness.target(TARGET),
                    harness.environment(),
                );
                assert.ok(opened.ok, JSON.stringify(opened));
                try {
                    await assert.rejects(opened.value.close(), {
                        message: WHY_THE_EGRESS_WOULD_NOT_CLOSE,
                    });
                } finally {
                    await failing.relay.close();
                }
            });
        });
    });
});
