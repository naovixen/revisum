// What the browser refuses of the decisions on a second tab's requests belongs to the whole session, so
// it outlives the tab. These tests open a second page, so each has a browser launched for it alone:
// auto-attach is browser-wide, and a shared browser's pages can hang or be let go before their network
// rules apply.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { outcomes } from "#test-support/browser/BrowserHarness.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { navigate, newTab, testId, visible } from "#test-support/browser/RawPlan.ts";
import {
    startRelayedDriverOnItsOwnBrowser,
    type RelayedDriverOnItsOwnBrowser,
} from "#test-support/browser/driver/RelayedDriver.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 2000;
const ADAPTER_ERROR = "adapter-error";
const PAGE_READY = "/ready.html";
const PAGE_NEVER_REACHED = "/never-reached.html";

const READY_IS_SHOWN = visible(testId("ready"), "refusals.ready-shown");

const pageRoute: FixtureRoute = () => ({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><p data-testid="ready">Ready</p></body></html>`,
});

const ROUTES = new Map<string, FixtureRoute>([
    [PAGE_READY, pageRoute],
    [PAGE_NEVER_REACHED, pageRoute],
]);

describe("Using a run in a real browser", () => {
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
        relayed.relay.tamperWith({
            method: "Fetch.continueRequest",
            applies: ({ pausedUrl }) => pausedUrl?.endsWith(PAGE_NEVER_REACHED) ?? false,
            change: { refusal: "Invalid parameters: this decision was refused" },
        });
    });
    afterEach(async () => {
        await relayed.close();
    });

    describe("given the browser refuses a decision on a request in a second tab", () => {
        describe("when a plan opens the tab", () => {
            test("then it should end Errored, with the tab's step marked adapter-error", async () => {
                const { result } = await harness.runSteps(
                    TARGET,
                    [navigate(PAGE_READY), newTab(PAGE_NEVER_REACHED, [READY_IS_SHOWN])],
                    { drivers: new Map([[ADAPTER_OF_TARGET[TARGET], relayed.driver]]) },
                );
                assert.ok(relayed.relay.timesTampered() > 0, "the decision was refused");
                assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                assert.deepEqual(outcomes(result)[1], [1, "failed", ADAPTER_ERROR]);
            });
        });

        describe("and the tab has closed", () => {
            describe("when the session is asked what was refused", () => {
                test("then it should hold the refusal, and fail what the first tab does next", async () => {
                    const opened = await relayed.driver.open(
                        harness.target(TARGET),
                        harness.environment(),
                    );
                    assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
                    const session = opened.value;
                    try {
                        assert.ok(
                            (await session.navigate(harness.url(PAGE_READY), scriptsEnabled)).ok,
                        );
                        const tab = await session.newTab(harness.url(PAGE_NEVER_REACHED));
                        assert.ok(!tab.ok, "the tab's page does not load");
                        const refusals = session.recordsSoFar().refusedRequestDecisions;
                        assert.ok(refusals.ok, JSON.stringify(refusals));
                        assert.match(refusals.value.join(), /this decision was refused/);
                        const next = await session.navigate(
                            harness.url(PAGE_READY),
                            scriptsEnabled,
                        );
                        assert.ok(!next.ok, "the first tab's next step fails");
                        assert.equal(next.error.code, "navigation-failed");
                        assert.match(next.error.detail, /this decision was refused/);
                    } finally {
                        await session.close();
                    }
                });
            });
        });
    });
});
