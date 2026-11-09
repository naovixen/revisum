// A selector the browser rejects matches nothing, which is exactly what a negative check is looking
// for. The plan is wrong, not the page, so such a check must fail with selector-invalid, or a typo in
// a plan reads as a pass for as long as nobody looks.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { navigate, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { assertStepFailedWith } from "../../support/browser/harnesses/AssertStepFailedWith.ts";
import {
    TARGET,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const PAGE_PATH = "/orders.html";
const CHECK_STEP = 1;
const CRITERION = "orders.error-gone";

const css = (selector: string): JsonRecord => ({ by: "css", selector });
const xpath = (expression: string): JsonRecord => ({ by: "xpath", expression });

const MALFORMED_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] = [
    { name: "a css selector", locator: css("p[[[") },
    { name: "an XPath expression", locator: xpath("//p[") },
];

const WELL_FORMED_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] = [
    { name: "a css selector", locator: css("p.no-such-class") },
    { name: "an XPath expression", locator: xpath("//p[contains(text(), 'No such text')]") },
];

const NEGATIVE_CHECKS: readonly { readonly name: string; readonly assertion: JsonRecord }[] = [
    { name: "an absent", assertion: { kind: "absent" } },
    { name: "a hidden", assertion: { kind: "hidden" } },
    { name: "a countEquals 0", assertion: { kind: "countEquals", value: 0 } },
];

const checkOf = (locator: JsonRecord, assertion: JsonRecord): JsonRecord => ({
    type: "expect",
    locator,
    assert: assertion,
    criterionId: CRITERION,
});

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: 1000,
        unsafeFeatures: { cssLocators: true, xpathLocators: true },
        routes: new Map([[PAGE_PATH, htmlPage("<p>Your orders</p>")]]),
    });
});
after(async () => {
    await harness.close();
});

const runCheck = async (locator: JsonRecord, assertion: JsonRecord) =>
    (await harness.runSteps(TARGET, [navigate(PAGE_PATH), checkOf(locator, assertion)])).result;

describe("Using a run in a real browser", () => {
    for (const { name, locator } of MALFORMED_LOCATORS) {
        for (const check of NEGATIVE_CHECKS) {
            describe(`given ${name} the browser rejects`, () => {
                describe(`when ${check.name} check of it runs`, () => {
                    test("then it should fail the check with selector-invalid", async () => {
                        const result = await runCheck(locator, check.assertion);
                        assertStepFailedWith(result, CHECK_STEP, "selector-invalid");
                    });
                });
            });
        }

        describe(`given ${name} the browser rejects`, () => {
            describe("when a visible check of it runs", () => {
                test("then it should fail the check with selector-invalid", async () => {
                    const result = await runCheck(locator, { kind: "visible" });
                    assertStepFailedWith(result, CHECK_STEP, "selector-invalid");
                });
            });
        });
    }

    for (const { name, locator } of WELL_FORMED_LOCATORS) {
        for (const check of NEGATIVE_CHECKS) {
            describe(`given ${name} that matches nothing on the page`, () => {
                describe(`when ${check.name} check of it runs`, () => {
                    test("then it should pass", async () => {
                        const result = await runCheck(locator, check.assertion);
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        }
    }
});
