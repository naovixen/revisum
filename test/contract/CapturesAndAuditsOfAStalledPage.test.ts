// A page whose script never yields answers nothing, whatever is asked of it. A capture or an audit of
// one gives up at about the step's timeout, as a click or a check does, rather than hold the run for
// as long as the browser's own commands allow.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
    outcomes,
    stepMilliseconds,
    type BrowserHarness,
} from "#test-support/browser/BrowserHarness.ts";
import {
    capture,
    click,
    navigate,
    newTab,
    role,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { TARGET, htmlPage, routedPagesHarness } from "./RoutedPagesHarness.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4_000;
// Two step timeouts is what a step may use at worst: the wait itself, and one read that overran it.
const LONGEST_STEP_MILLISECONDS = 2 * STEP_TIMEOUT_MILLISECONDS;
const LONGEST_TEST_MILLISECONDS = 120_000;

const STALL_BUTTON = "Stall the page";
const PAGE = "/stalls.html";
const STEP_ON_THE_PAGE = 3;
const OTHER_PAGE = "/waits.html";
const WAITED = "waited";

// The click must land before the page stops answering, so the stall starts a moment later.
const STALLING_PAGE = `<button type="button" onclick="setTimeout(() => { for (;;) {} }, 300)">${STALL_BUTTON}</button>`;

const AUDIT: JsonRecord = { type: "a11yAudit", mode: "report" };
const SHOT = "stalled";
// A second tab gives the stall time to begin: nothing can be read from the first page once it has.
const WAIT_IN_ANOTHER_TAB: JsonRecord = newTab(OTHER_PAGE, [
    visible(testId(WAITED), "stalled.other-tab-shown"),
]);
const OTHER_TAB_PAGE = `<p data-testid="${WAITED}" hidden>Waited</p><script>setTimeout(() => { document.querySelector("[data-testid=${WAITED}]").hidden = false; }, 1500);</script>`;
const CLOSING_CHECK: JsonRecord = {
    type: "expect",
    locator: testId("never-shown"),
    assert: { kind: "absent" },
    criterionId: "stalled.page-read",
};

const STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a capture", step: capture(SHOT) },
    { name: "an audit", step: AUDIT },
];

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        routes: new Map([
            [PAGE, htmlPage(STALLING_PAGE)],
            [OTHER_PAGE, htmlPage(OTHER_TAB_PAGE)],
        ]),
    });
});
after(async () => {
    await harness.close();
});

describe("Using a run in a real browser", () => {
    for (const { name, step } of STEPS) {
        describe(`given ${name} of a page whose script has stopped yielding`, () => {
            describe("when the run reaches it", () => {
                test(
                    "then it should end the step at about the step's timeout, with nothing kept",
                    { timeout: LONGEST_TEST_MILLISECONDS },
                    async () => {
                        const { result, store } = await harness.runSteps(TARGET, [
                            navigate(PAGE),
                            click(role("button", STALL_BUTTON)),
                            WAIT_IN_ANOTHER_TAB,
                            step,
                            CLOSING_CHECK,
                        ]);
                        const took = stepMilliseconds(result, STEP_ON_THE_PAGE);
                        assert.ok(
                            took < LONGEST_STEP_MILLISECONDS,
                            `it took ${took} ms: ${JSON.stringify(outcomes(result))}`,
                        );
                        assert.equal(store.get(`${TARGET}/${SHOT}.png`), undefined);
                        assert.equal(result.steps[STEP_ON_THE_PAGE]?.findings, undefined);
                    },
                );
            });
        });

        describe(`given ${name} of a page that still answers`, () => {
            describe("when the run reaches it", () => {
                test("then it should pass well within the step's timeout", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate(PAGE),
                        step,
                        CLOSING_CHECK,
                    ]);
                    assert.equal(result.steps[1]?.outcome, "passed", JSON.stringify(result.steps));
                    assert.ok(stepMilliseconds(result, 1) < STEP_TIMEOUT_MILLISECONDS);
                });
            });
        });
    }
});
