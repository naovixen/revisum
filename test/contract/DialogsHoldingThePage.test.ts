// While a dialog is open the page runs no script and answers no read, and only a dialog step can
// free it. One state has one code: every step that needs the page says dialog-open, at once, whether
// the dialog was open before the step began or a page timer opened it while the step was reading.
// The step timeout is long, so a step that waits it out cannot pass for one that stops at once.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
    stepMilliseconds,
    type BrowserHarness,
    type BrowserRun,
} from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    navigate,
    pathStartsWith,
    press,
    rawPlan,
    remember,
    role,
    testId,
    textEquals,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { assertStepFailedWith } from "./AssertStepFailedWith.ts";
import { download } from "./page-states-support.ts";
import { TARGET, htmlPage, routedPagesHarness } from "./RoutedPagesHarness.ts";
import { evaluate, expectScript, inlineScript } from "./unsafe-page-support.ts";
import { approvedStanding } from "../unit/engine/policy-examples.ts";

shareBrowserInThisFile();

const LONG_STEP_TIMEOUT_MILLISECONDS = 8000;
const AT_ONCE_MILLISECONDS = 4000;

const ASK_A_QUESTION = role("button", "Ask a question");
const ASK_BY_CSS = { by: "css", selector: "#ask" };
const OPENS_THE_DIALOG = [navigate("/dialog.html"), click(ASK_A_QUESTION)];
const ANSWER_THE_DIALOG = { type: "dialog", action: "accept" };
const DIALOG_STATUS = testId("dialog-status");
const ON_THE_DIALOG_PAGE = pathStartsWith("/dialog", "dialog.page-shown");

const READ_THE_TITLE = inlineScript("function () { return { title: document.title }; }", "read", {
    title: "/title",
});
const SCRIPT_THAT_READS_THE_TITLE = evaluate(READ_THE_TITLE);
const SCRIPT_CHECK_OF_THE_TITLE = expectScript(
    READ_THE_TITLE,
    {},
    "title",
    { kind: "equals", value: "Draft" },
    "dialog.title-read",
);

const TIMER_PAGE = "/dialog-on-a-timer.html";
const READ_PAGE = "/dialog-during-a-read.html";
const START = testId("start");
const NOTE = testId("note");
const NEVER_ENABLED = testId("never-enabled");
const NOT_THIS_TITLE = {
    type: "expectPage",
    assert: { kind: "title", value: "A title the page never has" },
    criterionId: "dialog.title-never-shown",
};

const CONTROLS = `
  <button type="button" data-testid="start">Start</button>
  <button type="button" data-testid="never-enabled" disabled>Never enabled</button>
  <p data-testid="note">Shown</p>`;

// The Start button sets a timer that opens a dialog while the next step is under way.
const DIALOG_ON_A_TIMER = `${CONTROLS}
  <script>
    document.querySelector('[data-testid="start"]').addEventListener('click', () => {
      setTimeout(() => { window.alert('Held'); }, 300);
    });
  </script>`;

// After the Start button, the next search of the document sets a timer that opens a dialog as soon
// as that search ends, which lands the dialog between the commands of one read.
const DIALOG_DURING_A_READ = `${CONTROLS}
  <script>
    const search = Document.prototype.querySelectorAll;
    let isArmed = false;
    document.querySelector('[data-testid="start"]').addEventListener('click', () => { isArmed = true; });
    Document.prototype.querySelectorAll = function (selector) {
      if (isArmed) {
        isArmed = false;
        setTimeout(() => { window.alert('Held'); }, 0);
      }
      return search.call(this, selector);
    };
  </script>`;

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: LONG_STEP_TIMEOUT_MILLISECONDS,
        unsafeFeatures: {
            cssLocators: true,
            pageScripts: { scripts: {}, allowInline: true },
        },
        routes: new Map([
            [TIMER_PAGE, htmlPage(DIALOG_ON_A_TIMER)],
            [READ_PAGE, htmlPage(DIALOG_DURING_A_READ)],
        ]),
    });
});
after(async () => {
    await harness.close();
});

// A plan must check something, whatever its last step does, and only an approved plan may run a
// script written in the plan.
const runApproved = async (steps: readonly JsonRecord[]): Promise<BrowserRun> => {
    const plan = harness.plan(
        rawPlan(
            { featureId: "PAGES-1", specReference: "specs/pages.md#dialogs", title: "Dialogs" },
            TARGET,
            [...steps, pathStartsWith("/", "page.shown")],
        ),
    );
    return harness.run(plan, TARGET, { standing: await approvedStanding(plan) });
};

const assertFailsAtOnceWithDialogOpen = async (
    stepsBefore: readonly JsonRecord[],
    step: JsonRecord,
): Promise<void> => {
    const { result } = await runApproved([...stepsBefore, step]);
    assertStepFailedWith(result, stepsBefore.length, "dialog-open");
    const took = stepMilliseconds(result, stepsBefore.length);
    assert.ok(took < AT_ONCE_MILLISECONDS, `took ${took} ms`);
};

const STEPS_THAT_NEED_THE_PAGE: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "an expectPage check", step: ON_THE_DIALOG_PAGE },
    { name: "a click", step: click(ASK_A_QUESTION) },
    { name: "a hover", step: { type: "hover", locator: ASK_A_QUESTION } },
    { name: "a key press", step: press(ASK_A_QUESTION, "Enter") },
    { name: "a download step", step: download("answers", ASK_A_QUESTION) },
    { name: "a download step found by CSS selector", step: download("answers", ASK_BY_CSS) },
    { name: "a page script check", step: SCRIPT_CHECK_OF_THE_TITLE },
];

describe("Using a run in a real browser", () => {
    describe("given a click has opened a confirm dialog that nothing answers", () => {
        for (const { name, step } of STEPS_THAT_NEED_THE_PAGE) {
            describe(`when ${name} runs next`, () => {
                test("then it should fail the step with dialog-open, at once", async () => {
                    await assertFailsAtOnceWithDialogOpen(OPENS_THE_DIALOG, step);
                });
            });
        }

        // A page script run for set-up that cannot run leaves the run unable to test, whatever stopped it.
        describe("when a page script runs next as set-up", () => {
            test("then it should fail the step with dialog-open, at once, and end the run Errored", async () => {
                const { result } = await runApproved([
                    ...OPENS_THE_DIALOG,
                    SCRIPT_THAT_READS_THE_TITLE,
                ]);
                const scriptStep = OPENS_THE_DIALOG.length;
                assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                assert.equal(result.steps[scriptStep]?.outcome, "failed");
                assert.equal(
                    result.steps[scriptStep].code,
                    "dialog-open",
                    JSON.stringify(result.steps),
                );
                const took = stepMilliseconds(result, scriptStep);
                assert.ok(took < AT_ONCE_MILLISECONDS, `took ${took} ms`);
            });
        });
    });

    describe("given a click has opened a confirm dialog and a dialog step has answered it", () => {
        for (const { name, step } of [
            { name: "an expectPage check", step: ON_THE_DIALOG_PAGE },
            { name: "a hover", step: { type: "hover", locator: ASK_A_QUESTION } },
            { name: "a page script", step: SCRIPT_THAT_READS_THE_TITLE },
        ]) {
            describe(`when ${name} runs next`, () => {
                test("then it should pass the run", async () => {
                    const { result } = await runApproved([
                        ...OPENS_THE_DIALOG,
                        ANSWER_THE_DIALOG,
                        step,
                        textEquals(DIALOG_STATUS, "Kept", "dialog.kept"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        }
    });

    describe("given a page timer opens a dialog while an expectPage check waits", () => {
        describe("when the run ends", () => {
            test("then it should fail the check with dialog-open, at once", async () => {
                await assertFailsAtOnceWithDialogOpen(
                    [navigate(TIMER_PAGE), click(START)],
                    NOT_THIS_TITLE,
                );
            });
        });
    });

    describe("given a page timer opens a dialog while a click waits for its element", () => {
        describe("when the run ends", () => {
            test("then it should fail the click with dialog-open, at once", async () => {
                await assertFailsAtOnceWithDialogOpen(
                    [navigate(TIMER_PAGE), click(START)],
                    click(NEVER_ENABLED),
                );
            });
        });
    });

    describe("given a page timer opens a dialog in the middle of a read", () => {
        for (const { name, step } of [
            { name: "a visible check", step: visible(NOTE, "note.shown") },
            { name: "a remember", step: remember("note", NOTE) },
        ]) {
            describe(`when ${name} reads the page`, () => {
                test("then it should fail the step with dialog-open, at once", async () => {
                    await assertFailsAtOnceWithDialogOpen(
                        [navigate(READ_PAGE), click(START)],
                        step,
                    );
                });
            });
        }
    });

    describe("given the same page and no press of its Start button", () => {
        describe("when a visible check reads the page", () => {
            test("then it should pass the run", async () => {
                const { result } = await runApproved([
                    navigate(READ_PAGE),
                    visible(NOTE, "note.shown"),
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
