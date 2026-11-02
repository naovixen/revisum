// A page's text reaches a locator with its white space collapsed, so text a plan or an API gives
// with a double space must be collapsed too. Otherwise it never matches, and an "absent" check passes
// with the element right there on the page.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    label,
    navigate,
    reference,
    role,
    testId,
    text,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { rememberResponse } from "./network-stubs-support.ts";
import {
    TARGET,
    htmlPage,
    jsonRoute,
    requestMatcher,
    routedPagesHarness,
} from "./RoutedPagesHarness.ts";

shareBrowserInThisFile();

const MESSAGE = "Order failed";
const SPACED_MESSAGE = "Order  failed";

const MESSAGES_PAGE = htmlPage(`
  <p>${MESSAGE}</p>
  <label for="email">Email address</label><input id="email" type="text">
  <button type="button">Save changes</button>
  <p data-testid="state">Waiting</p>
  <script>
    fetch('/api/message').then((answer) => answer.json()).then(() => {
      document.querySelector('[data-testid="state"]').textContent = 'Answered';
    });
  </script>`);

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        routes: new Map([
            ["/messages.html", MESSAGES_PAGE],
            ["/api/message", jsonRoute({ message: SPACED_MESSAGE })],
        ]),
        observedRequests: (origin) => ({
            message: {
                request: requestMatcher(origin, "/api/message"),
                fields: { message: "/message" },
            },
        }),
        unsafeFeatures: { cssLocators: true },
    });
});
after(async () => {
    await harness.close();
});

const OPEN_PAGE = navigate("/messages.html");
const check = (locator: JsonRecord, kind: string): JsonRecord => ({
    type: "expect",
    locator,
    assert: { kind },
    criterionId: "messages.checked",
});

const SPACED_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] = [
    { name: "text", locator: text(SPACED_MESSAGE) },
    { name: "a label", locator: label("Email  address") },
    { name: "a role's name", locator: role("button", "Save  changes") },
];

describe("Using a run in a real browser", () => {
    for (const { name, locator } of SPACED_LOCATORS) {
        describe(`given an absent check of ${name} written with a double space`, () => {
            describe("and the element is on the page", () => {
                describe("when the check runs", () => {
                    test("then it should fail", async () => {
                        const { result } = await harness.runSteps(TARGET, [
                            OPEN_PAGE,
                            check(locator, "absent"),
                        ]);
                        assert.deepEqual(
                            outcomes(result)[1],
                            [1, "failed", "assertion-failed"],
                            JSON.stringify(result.steps),
                        );
                    });
                });
            });
        });

        describe(`given a visible check of ${name} written with a double space`, () => {
            describe("and the element is on the page", () => {
                describe("when the check runs", () => {
                    test("then it should pass", async () => {
                        const { result } = await harness.runSteps(TARGET, [
                            OPEN_PAGE,
                            check(locator, "visible"),
                        ]);
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }

    describe("given an absent check of text an API gave with a double space", () => {
        describe("and the element is on the page", () => {
            describe("when the check runs", () => {
                test("then it should fail", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        OPEN_PAGE,
                        textEquals(testId("state"), "Answered", "messages.answered"),
                        rememberResponse("wanted", "message", "message", "text"),
                        check(text(reference("wanted")), "absent"),
                    ]);
                    assert.deepEqual(
                        outcomes(result)[3],
                        [3, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });

    describe("given an absent check of text written with one space", () => {
        describe("and the element is on the page", () => {
            describe("when the check runs", () => {
                test("then it should fail", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        OPEN_PAGE,
                        check(text(MESSAGE), "absent"),
                    ]);
                    assert.deepEqual(
                        outcomes(result)[1],
                        [1, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });

    describe("given an absent check of text written with a double space", () => {
        describe("and no such element is on the page", () => {
            describe("when the check runs", () => {
                test("then it should pass", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        OPEN_PAGE,
                        check(text("Nothing  like this"), "absent"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    });

    describe("given an absent check of a css locator whose hasText has a double space", () => {
        describe("and the element is on the page", () => {
            describe("when the check runs", () => {
                test("then it should fail", async () => {
                    const locator: JsonRecord = {
                        by: "css",
                        selector: "p",
                        hasText: SPACED_MESSAGE,
                    };
                    const { result } = await harness.runSteps(TARGET, [
                        OPEN_PAGE,
                        check(locator, "absent"),
                    ]);
                    assert.deepEqual(
                        outcomes(result)[1],
                        [1, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });
});
