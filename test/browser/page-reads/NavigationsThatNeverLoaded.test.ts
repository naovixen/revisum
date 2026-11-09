// A click follows a link, and the page never loads: the server refuses the connection, or the
// allow-list blocks it. The browser then shows its own error page while its address bar holds the
// URL it wanted, so a check of the URL must not read that as having arrived.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { click, navigate, role, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    TARGET,
    closedOrigin,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";
import { StepOutcome } from "@revisum/contracts";

shareBrowserInThisFile();

const ORDER_PATH = "/orders/done";
const REFUSED_LINK = "Go to the refused page";
const BLOCKED_LINK = "Go to the blocked page";
const HEALTHY_LINK = "Go to the healthy page";

let harness: BrowserHarness;
let refusedOrigin: string;

before(async () => {
    refusedOrigin = await closedOrigin();
    const blockedOrigin = await closedOrigin();
    harness = await routedPagesHarness({
        otherOrigins: [refusedOrigin],
        routes: new Map([
            [
                "/start.html",
                htmlPage(`
                  <a href="${refusedOrigin}${ORDER_PATH}">${REFUSED_LINK}</a>
                  <a href="${blockedOrigin}${ORDER_PATH}">${BLOCKED_LINK}</a>
                  <a href="${ORDER_PATH}">${HEALTHY_LINK}</a>`),
            ],
            [ORDER_PATH, htmlPage("<h1>Order done</h1>")],
        ]),
    });
});
after(async () => {
    await harness.close();
});

const expectPage = (assertion: JsonRecord): JsonRecord => ({
    type: "expectPage",
    assert: assertion,
    criterionId: "orders.page-reached",
});

const PAGE_CHECKS: readonly { readonly name: string; readonly assertion: () => JsonRecord }[] = [
    { name: "urlPath", assertion: () => ({ kind: "urlPath", value: ORDER_PATH }) },
    {
        name: "urlPathStartsWith",
        assertion: () => ({ kind: "urlPathStartsWith", value: "/orders" }),
    },
    { name: "url", assertion: () => ({ kind: "url", value: `${refusedOrigin}${ORDER_PATH}` }) },
];

const planClicking = (linkName: string, assertion: JsonRecord): readonly JsonRecord[] => [
    navigate("/start.html"),
    click(role("link", linkName)),
    expectPage(assertion),
];

describe("Using a run in a real browser", () => {
    for (const { name, assertion } of PAGE_CHECKS) {
        describe(`given a click on a link to a server that refuses the connection, then a ${name} check of that link`, () => {
            describe("when the run ends", () => {
                test("then it should fail with navigation-failed", async () => {
                    const { result } = await harness.runSteps(
                        TARGET,
                        planClicking(REFUSED_LINK, assertion()),
                    );
                    assert.notEqual(result.state, "Passed", JSON.stringify(result.steps));
                    const firstFailed = result.steps.find(
                        (step) => step.outcome === StepOutcome.Failed,
                    );
                    assert.equal(
                        firstFailed?.code,
                        "navigation-failed",
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    }

    describe("given a click on a link the allow-list blocks, then a urlPath check of that link", () => {
        describe("when the run ends", () => {
            test("then it should fail with navigation-failed", async () => {
                const { result } = await harness.runSteps(
                    TARGET,
                    planClicking(BLOCKED_LINK, { kind: "urlPath", value: ORDER_PATH }),
                );
                assert.notEqual(result.state, "Passed", JSON.stringify(result.steps));
                const firstFailed = result.steps.find(
                    (step) => step.outcome === StepOutcome.Failed,
                );
                assert.equal(firstFailed?.code, "navigation-failed", JSON.stringify(result.steps));
            });
        });
    });

    describe("given a click on a link to a page that loads, then a urlPath check of that link", () => {
        describe("when the run ends", () => {
            test("then it should pass", async () => {
                const { result } = await harness.runSteps(
                    TARGET,
                    planClicking(HEALTHY_LINK, { kind: "urlPath", value: ORDER_PATH }),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
