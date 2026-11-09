// A check that an element is absent or hidden passes when nothing is on screen, and the browser's
// own error page has nothing of the application on it. A click whose page never loaded must not read
// as the element having gone. The element checked is on the first page, so the check cannot pass
// until the click's navigation has ended, whatever the machine's speed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { click, navigate, role, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { assertStepFailedWith } from "../../support/browser/harnesses/AssertStepFailedWith.ts";
import { TARGET, closedOrigin, htmlPage, routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const CHECK_STEP = 2;
const FIRST_PAGE_NOTE = testId("first-page-note");

const REFUSED_LINK = "Go to the refused page";
const BLOCKED_LINK = "Go to the blocked page";
const EMPTY_ERROR_LINK = "Go to the empty error page";
const LOADED_LINK = "Go to the loaded page";
const ERROR_WITH_BODY_LINK = "Go to the error page with a body";

const LOADED_PATH = "/orders/done";
const ERROR_WITH_BODY_PATH = "/orders/missing";
const EMPTY_ERROR_PATH = "/orders/nothing-here";

const LINKS_THAT_NEVER_LOAD: readonly { readonly name: string; readonly link: string }[] = [
    { name: "a server that refuses the connection", link: REFUSED_LINK },
    { name: "an origin the allow-list blocks", link: BLOCKED_LINK },
    { name: "an HTTP error with an empty body", link: EMPTY_ERROR_LINK },
];

const LINKS_THAT_LOAD: readonly { readonly name: string; readonly link: string }[] = [
    { name: "a page that loads", link: LOADED_LINK },
    { name: "an HTTP error with a body the browser shows", link: ERROR_WITH_BODY_LINK },
];

const NEGATIVE_CHECKS: readonly { readonly name: string; readonly assertion: JsonRecord }[] = [
    { name: "an absent", assertion: { kind: "absent" } },
    { name: "a hidden", assertion: { kind: "hidden" } },
    { name: "a countEquals 0", assertion: { kind: "countEquals", value: 0 } },
];

let harness: BrowserHarness;

before(async () => {
    const refusedOrigin = await closedOrigin();
    const blockedOrigin = await closedOrigin();
    harness = await routedPagesHarness({
        otherOrigins: [refusedOrigin],
        routes: new Map([
            [
                "/start.html",
                htmlPage(`
                  <p data-testid="first-page-note">On the first page</p>
                  <a href="${refusedOrigin}/orders">${REFUSED_LINK}</a>
                  <a href="${blockedOrigin}/orders">${BLOCKED_LINK}</a>
                  <a href="${EMPTY_ERROR_PATH}">${EMPTY_ERROR_LINK}</a>
                  <a href="${LOADED_PATH}">${LOADED_LINK}</a>
                  <a href="${ERROR_WITH_BODY_PATH}">${ERROR_WITH_BODY_LINK}</a>`),
            ],
            [LOADED_PATH, htmlPage("<h1>Order done</h1>")],
            [
                ERROR_WITH_BODY_PATH,
                (request) => ({ ...htmlPage("<h1>No such order</h1>")(request), status: 404 }),
            ],
            [EMPTY_ERROR_PATH, () => ({ status: 404 })],
        ]),
    });
});
after(async () => {
    await harness.close();
});

const planClicking = (linkName: string, assertion: JsonRecord): readonly JsonRecord[] => [
    navigate("/start.html"),
    click(role("link", linkName)),
    {
        type: "expect",
        locator: FIRST_PAGE_NOTE,
        assert: assertion,
        criterionId: "orders.first-page-gone",
    },
];

describe("Using a run in a real browser", () => {
    for (const check of NEGATIVE_CHECKS) {
        for (const { name, link } of LINKS_THAT_NEVER_LOAD) {
            describe(`given a click on a link to ${name}, then ${check.name} check`, () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with navigation-failed", async () => {
                        const { result } = await harness.runSteps(
                            TARGET,
                            planClicking(link, check.assertion),
                        );
                        assertStepFailedWith(result, CHECK_STEP, "navigation-failed");
                    });
                });
            });
        }

        for (const { name, link } of LINKS_THAT_LOAD) {
            describe(`given a click on a link to ${name}, then ${check.name} check`, () => {
                describe("when the run ends", () => {
                    test("then it should pass", async () => {
                        const { result } = await harness.runSteps(
                            TARGET,
                            planClicking(link, check.assertion),
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        }
    }
});
