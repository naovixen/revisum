// The runtime guard judges every element a css or XPath locator resolves for an action, as it
// judges any other, in a real browser on the CDP driver (test/fixtures/sites/unsafe-features-app/guard.html):
//   - a button named "Delete account", found by its class, its place in the page, or by hasText
//     inside a section, ends the run Denied with irreversible-action, and the page receives no
//     input event at all (the page counts every press, click, key and value change);
//   - a control with no accessible name ends the run Denied with unnamed-control, unless the exact
//     selector that found it is listed in the project's unnamedControlsAllowed. A selector that
//     finds the same control but is not the listed text is denied.
// A selector or expression the browser rejects fails its step with selector-invalid, with nothing
// sent. Each deny is paired with an allowed click found the same way, whose input does reach the
// page, so the counter is shown able to move.
// The engine-level half, the guard's verdicts on resolved elements, is in
// test/unit/engine/policy/step-families/PolicyUnsafeFeatures.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { outcomes, type BrowserRun } from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    navigate,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import {
    ALLOWED_UNNAMED_SELECTOR,
    UNSAFE_PAGE_TARGETS,
    css,
    unsafePageHarness,
    xpath,
    type UnsafePageHarness,
} from "../page-scripts/support/UnsafePagePlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";

shareBrowserInThisFile();

let harness: UnsafePageHarness;
before(async () => {
    harness = await unsafePageHarness();
});
after(async () => {
    await harness.close();
});

const STATES = ["input-events", "account-state", "details-state", "toolbar-state"];

// Opens the guard page and clicks `locator`, then checks a state the click would change. Nothing
// before the click sends input, so a denied click leaves the input counter at 0.
const clickOnGuardPage = (
    targetId: string,
    locator: JsonRecord,
    followUp: JsonRecord,
): Promise<BrowserRun> =>
    harness.runSteps(targetId, [navigate("/guard.html"), click(locator), followUp], {
        read: STATES,
    });

const accountKept = (): JsonRecord =>
    textEquals(testId("account-state"), "Account kept", "guard.account-kept");

function assertDenied(ran: BrowserRun, rule: string): void {
    assert.equal(ran.result.state, "Denied", JSON.stringify(ran.result.steps));
    assert.deepEqual(ran.result.denial, { rule, stepIndex: 1 });
    assert.equal(ran.result.steps[1]?.code, "policy-denied");
    assert.equal(ran.atClose?.shown["input-events"], "0", "no input event reached the page");
}

function assertClickReachedPage(ran: BrowserRun): void {
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
    assert.notEqual(ran.atClose?.shown["input-events"], "0", "the click reached the page");
}

// Every way of finding the "Delete account" button by page structure.
const DELETE_ACCOUNT_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord }[] =
    [
        { name: "the CSS selector button.danger", locator: css("button.danger") },
        {
            name: "an XPath expression by its place in the page",
            locator: xpath("//main/section[1]/button[1]"),
        },
        {
            name: "a CSS selector with hasText inside another CSS locator",
            locator: css("button", { hasText: "Delete account", inside: css("section.account") }),
        },
        {
            name: "a CSS selector with a position",
            locator: css("section.account button", { position: "first" }),
        },
    ];

for (const targetId of UNSAFE_PAGE_TARGETS) {
    describe(`irreversible actions found by structure: ${targetId}`, () => {
        for (const { name, locator } of DELETE_ACCOUNT_LOCATORS) {
            test(`a click on "Delete account" found by ${name} is denied irreversible-action with zero input events`, async () => {
                const ran = await clickOnGuardPage(targetId, locator, accountKept());
                assertDenied(ran, "irreversible-action");
                assert.equal(ran.atClose?.shown["account-state"], "Account kept");
            });
        }

        // Counter-examples: the same kinds of locator finding a harmless button do click it.
        test('counter-example: button.safe, named "Show details", is clicked and the page shows it', async () => {
            const ran = await clickOnGuardPage(
                targetId,
                css("button.safe"),
                textEquals(testId("details-state"), "Details shown", "guard.details-shown"),
            );
            assertClickReachedPage(ran);
        });

        test('counter-example: the XPath expression for the second button of the section clicks "Show details"', async () => {
            const ran = await clickOnGuardPage(
                targetId,
                xpath("//main/section[1]/button[2]"),
                textEquals(testId("details-state"), "Details shown", "guard.details-shown"),
            );
            assertClickReachedPage(ran);
        });
    });

    describe(`unnamed controls found by structure: ${targetId}`, () => {
        test("an icon button with no accessible name found by an unlisted css selector is denied unnamed-control with zero input events", async () => {
            const ran = await clickOnGuardPage(
                targetId,
                css("button.icon-menu"),
                textEquals(testId("toolbar-state"), "Toolbar untouched", "guard.toolbar-untouched"),
            );
            assertDenied(ran, "unnamed-control");
            assert.equal(ran.atClose?.shown["toolbar-state"], "Toolbar untouched");
        });

        test("an icon button with no accessible name found by an unlisted XPath expression is denied unnamed-control", async () => {
            const ran = await clickOnGuardPage(
                targetId,
                xpath("//main/section[2]/button[2]"),
                textEquals(testId("toolbar-state"), "Toolbar untouched", "guard.toolbar-untouched"),
            );
            assertDenied(ran, "unnamed-control");
        });

        test(`the unnamed icon button found by the exact listed selector ${ALLOWED_UNNAMED_SELECTOR} is clicked`, async () => {
            const ran = await clickOnGuardPage(
                targetId,
                css(ALLOWED_UNNAMED_SELECTOR),
                textEquals(testId("toolbar-state"), "Toolbar closed", "guard.toolbar-closed"),
            );
            assertClickReachedPage(ran);
        });

        // Mutant of the allow-list: the same control, found by a selector that holds the listed one but
        // is not it, is denied, so the list is matched exactly and not by what the selector resolves.
        test("the same unnamed button found by a selector that only contains the listed one is denied unnamed-control", async () => {
            const ran = await clickOnGuardPage(
                targetId,
                css(`section.toolbar ${ALLOWED_UNNAMED_SELECTOR}`),
                textEquals(testId("toolbar-state"), "Toolbar untouched", "guard.toolbar-untouched"),
            );
            assertDenied(ran, "unnamed-control");
            assert.equal(ran.atClose?.shown["toolbar-state"], "Toolbar untouched");
        });
    });

    describe(`selectors the browser rejects: ${targetId}`, () => {
        for (const { name, locator } of [
            { name: "a CSS selector", locator: css("button[") },
            { name: "an XPath expression", locator: xpath("//button[") },
        ]) {
            test(`a click found by ${name} the browser rejects fails with selector-invalid, sends nothing and skips the rest`, async () => {
                const ran = await clickOnGuardPage(targetId, locator, accountKept());
                assert.deepEqual(
                    outcomes(ran.result),
                    [
                        [0, "passed", undefined],
                        [1, "failed", "selector-invalid"],
                        [2, "skipped", undefined],
                    ],
                    JSON.stringify(ran.result.steps),
                );
                assert.equal(
                    ran.atClose?.shown["input-events"],
                    "0",
                    "no input event reached the page",
                );
            });
        }
    });
}
