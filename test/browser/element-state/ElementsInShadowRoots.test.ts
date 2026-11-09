// A web component draws its content inside a shadow root. A person sees that content like any other,
// so a check must too: an error shown inside a component must not let `absent`, `hidden` or
// `countEquals 0` pass. The pages use declarative shadow roots, so they are there as the page loads.
// What a closed root should give is not settled: a page's own scripts cannot reach into one, though
// a person can see it. All that is held here is that a run never contradicts itself about it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    label,
    navigate,
    role,
    testId,
    text,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { assertStepFailedWith } from "../../support/browser/harnesses/AssertStepFailedWith.ts";
import { TARGET, htmlPage, routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

// A check of an element on screen fails only when its wait runs out, so this keeps those tests short.
// An element in the page is there at its first look, so a slow machine cannot fail one that should pass.
const STEP_TIMEOUT_MILLISECONDS = 500;
const CHECK_STEP = 1;

const OPEN_ROOT_PATH = "/open-root.html";
const NESTED_ROOTS_PATH = "/nested-roots.html";
const CLOSED_ROOT_PATH = "/closed-root.html";
const INERT_TEMPLATE_PATH = "/inert-template.html";
const HIDDEN_IN_ROOT_PATH = "/hidden-in-root.html";
const LIGHT_AND_SHADOW_PATH = "/light-and-shadow.html";

const ORDER_ERROR_ID = "order-error";
// Text beside the element, so a shadow host's own text is never exactly what a locator wants.
const PANEL_CONTENT = `
  <label for="reason">Refund reason</label><input id="reason">
  <input aria-label="Order note">
  <span id="coupon-caption">Coupon code</span><input aria-labelledby="coupon-caption">
  <p data-testid="${ORDER_ERROR_ID}" class="order-error">Payment declined</p>
  <button>Retry payment</button>
  <p>Contact the shop for help</p>`;

const shadowHost = (mode: "open" | "closed", content: string): string =>
    `<checkout-panel><template shadowrootmode="${mode}">${content}</template></checkout-panel>`;

const css = (selector: string): JsonRecord => ({ by: "css", selector });

const LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] = [
    { name: "a label element", locator: label("Refund reason") },
    { name: "an aria-label", locator: label("Order note") },
    { name: "an aria-labelledby", locator: label("Coupon code") },
    { name: "its text", locator: text("Payment declined") },
    { name: "its role and name", locator: role("button", "Retry payment") },
    { name: "its test id", locator: testId(ORDER_ERROR_ID) },
    { name: "a css selector", locator: css(".order-error") },
];

const NOWHERE_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] = [
    { name: "a label", locator: label("Name on no element") },
    { name: "text", locator: text("Text on no element") },
    { name: "a role and name", locator: role("button", "Button on no page") },
    { name: "a test id", locator: testId("no-such-element") },
    { name: "a css selector", locator: css(".no-such-element") },
];

const ROOTS_THAT_SHOW_THE_ELEMENT: readonly { readonly name: string; readonly path: string }[] = [
    { name: "an open shadow root", path: OPEN_ROOT_PATH },
    { name: "an open shadow root inside another", path: NESTED_ROOTS_PATH },
];

const ABSENT: JsonRecord = { kind: "absent" };
const NEGATIVE_CHECKS: readonly { readonly name: string; readonly assertion: JsonRecord }[] = [
    { name: "an absent", assertion: ABSENT },
    { name: "a hidden", assertion: { kind: "hidden" } },
    { name: "a countEquals 0", assertion: { kind: "countEquals", value: 0 } },
];

const checkOf = (locator: JsonRecord, assertion: JsonRecord): JsonRecord => ({
    type: "expect",
    locator,
    assert: assertion,
    criterionId: "panel.element-checked",
});

let harness: BrowserHarness;

before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        unsafeFeatures: { cssLocators: true },
        routes: new Map([
            [OPEN_ROOT_PATH, htmlPage(shadowHost("open", PANEL_CONTENT))],
            [
                NESTED_ROOTS_PATH,
                htmlPage(
                    shadowHost(
                        "open",
                        `<p>The outer panel</p>${shadowHost("open", PANEL_CONTENT)}`,
                    ),
                ),
            ],
            [CLOSED_ROOT_PATH, htmlPage(shadowHost("closed", PANEL_CONTENT))],
            // A template with no shadowrootmode is inert: nothing in it is on the page or in any root.
            [
                INERT_TEMPLATE_PATH,
                htmlPage(
                    `${shadowHost("open", "<p>A panel holding something else</p>")}<template>${PANEL_CONTENT}</template>`,
                ),
            ],
            [
                HIDDEN_IN_ROOT_PATH,
                htmlPage(
                    shadowHost(
                        "open",
                        `<p data-testid="${ORDER_ERROR_ID}" style="display:none">Payment declined</p><p>Nothing wrong</p>`,
                    ),
                ),
            ],
            [
                LIGHT_AND_SHADOW_PATH,
                htmlPage(
                    `<p data-testid="${ORDER_ERROR_ID}">Payment declined</p>${shadowHost("open", PANEL_CONTENT)}`,
                ),
            ],
        ]),
    });
});
after(async () => {
    await harness.close();
});

const runOn = async (path: string, ...checks: readonly JsonRecord[]) =>
    (await harness.runSteps(TARGET, [navigate(path), ...checks])).result;

describe("Using a run in a real browser", () => {
    for (const { name: rootName, path } of ROOTS_THAT_SHOW_THE_ELEMENT) {
        for (const { name: locatorName, locator } of LOCATORS) {
            describe(`given a visible element in ${rootName}, found by ${locatorName}`, () => {
                for (const check of NEGATIVE_CHECKS) {
                    describe(`when ${check.name} check of it runs`, () => {
                        test("then it should fail the check with assertion-failed", async () => {
                            const result = await runOn(path, checkOf(locator, check.assertion));
                            assertStepFailedWith(result, CHECK_STEP, "assertion-failed");
                        });
                    });
                }

                describe("when a visible check of it runs", () => {
                    test("then it should pass", async () => {
                        const result = await runOn(path, visible(locator, "panel.element-shown"));
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        }
    }

    for (const { name, locator } of LOCATORS) {
        describe(`given a visible element in a closed shadow root, found by ${name}`, () => {
            describe("when both a visible and an absent check of it run", () => {
                test("then it should not pass both", async () => {
                    const seen = await runOn(
                        CLOSED_ROOT_PATH,
                        visible(locator, "panel.element-shown"),
                    );
                    const absent = await runOn(CLOSED_ROOT_PATH, checkOf(locator, ABSENT));
                    assert.equal(
                        seen.state === "Passed" && absent.state === "Passed",
                        false,
                        `visible: ${seen.state}, absent: ${absent.state}`,
                    );
                });
            });
        });
    }

    for (const { name, locator } of NOWHERE_LOCATORS) {
        describe(`given ${name} that matches nothing in any root`, () => {
            describe("and a page with nested open shadow roots", () => {
                describe("when absent, hidden and countEquals 0 checks run", () => {
                    test("then it should pass all of them", async () => {
                        const result = await runOn(
                            NESTED_ROOTS_PATH,
                            ...NEGATIVE_CHECKS.map((check) => checkOf(locator, check.assertion)),
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }

    for (const { name, locator } of LOCATORS) {
        describe(`given an element only in an inert template, found by ${name}`, () => {
            describe("when absent, hidden and countEquals 0 checks run", () => {
                test("then it should pass all of them", async () => {
                    const result = await runOn(
                        INERT_TEMPLATE_PATH,
                        ...NEGATIVE_CHECKS.map((check) => checkOf(locator, check.assertion)),
                    );
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    }

    describe("given an element a shadow root's content really hides", () => {
        describe("when a hidden check of it runs", () => {
            test("then it should pass", async () => {
                const result = await runOn(
                    HIDDEN_IN_ROOT_PATH,
                    checkOf(testId(ORDER_ERROR_ID), { kind: "hidden" }),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });

        describe("when a visible check of it runs", () => {
            test("then it should not pass", async () => {
                const result = await runOn(
                    HIDDEN_IN_ROOT_PATH,
                    visible(testId(ORDER_ERROR_ID), "panel.element-shown"),
                );
                assert.notEqual(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });

    describe("given one element in the page and one in a shadow root with the same test id", () => {
        describe("when a countEquals 2 check runs", () => {
            test("then it should pass", async () => {
                const result = await runOn(
                    LIGHT_AND_SHADOW_PATH,
                    checkOf(testId(ORDER_ERROR_ID), { kind: "countEquals", value: 2 }),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
