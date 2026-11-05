// A page can hold an element whose id or name matches a property the driver keeps for its click check,
// because the browser exposes named elements as properties of the window. Such a page must still be
// clicked, typed into and hovered like any other.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { performableLocator, type DocumentSession } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, fill, press, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import {
    ADDER,
    ASK,
    BUTTON,
    DIALOG_ON_PRESS_PAGES,
    FIELD,
    FRAME,
    NAMED_AFTER_A_CLICK_PAGE,
    NAMED_AND_ASKING_PAGE,
    NAMED_AND_COVERED_PAGE,
    NAMED_AT_LOAD_PAGE,
    NAMED_BY_FORM_PAGE,
    NAMED_BY_FRAME_PAGE,
    NAMED_BY_ID_PAGE,
    TALLY,
    TYPED_TEXT,
    framing,
} from "./DialogOnPressPages.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const STEP_PASSED = { ok: true, value: undefined };

type Outcome = { readonly failureCode: string | null; readonly tally: string };

const ONE_CLICK: Outcome = { failureCode: null, tally: "1" };

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, DIALOG_ON_PRESS_PAGES);
});
after(async () => {
    await harness.close();
});

const tallyIn = async (document: DocumentSession): Promise<string> =>
    expectOneElement(await document.probe(harness.locator(testId(TALLY)))).text;

const failureCodeOf = async (
    document: DocumentSession,
    step: JsonRecord,
): Promise<string | null> => {
    const acted = await document.act(harness.actionStep(step), allowEveryAction);
    return acted.ok ? null : acted.error.code;
};

const clickOutcomeIn = async (document: DocumentSession): Promise<Outcome> => ({
    failureCode: await failureCodeOf(document, click(testId(BUTTON))),
    tally: await tallyIn(document),
});

const enterOutcomeIn = async (document: DocumentSession): Promise<Outcome> => ({
    failureCode: await failureCodeOf(document, press(testId(BUTTON), "Enter")),
    tally: await tallyIn(document),
});

const onPage = async <Value>(
    page: string,
    use: (session: DocumentSession) => Promise<Value>,
): Promise<Value> => {
    const opened = await ownDriverFor(TARGET).open(harness.target(TARGET), harness.environment());
    assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
    const session = opened.value;
    try {
        assert.ok((await session.navigate(harness.url(page))).ok, `${page} loads`);
        return await use(session);
    } finally {
        await session.close();
    }
};

const enterFrameOf = async (document: DocumentSession): Promise<DocumentSession> => {
    const located = performableLocator(harness.locator(testId(FRAME)));
    assert.ok(located !== undefined, "the frame's locator is literal");
    const inner = await document.frame(located);
    assert.ok(inner.ok, `the frame is found: ${JSON.stringify(inner)}`);
    return inner.value;
};

describe("Using the real browser driver", () => {
    for (const { element, page } of [
        { element: "a div whose id is the click check's name", page: NAMED_BY_ID_PAGE },
        { element: "a form named like the click check", page: NAMED_BY_FORM_PAGE },
        { element: "an iframe named like the click check", page: NAMED_BY_FRAME_PAGE },
        { element: "a div with that id added by a script at load", page: NAMED_AT_LOAD_PAGE },
    ]) {
        describe(`given a page holding ${element}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass that click, with one click", async () => {
                    assert.deepEqual(await onPage(page, clickOutcomeIn), ONE_CLICK);
                });
            });

            describe("when a plan presses Enter on the button", () => {
                test("then it should pass the step, and the page should have one click", async () => {
                    assert.deepEqual(await onPage(page, enterOutcomeIn), ONE_CLICK);
                });
            });
        });
    }

    describe("given a page holding a div whose id is the click check's name", () => {
        describe("when a plan fills a field, then presses Enter on the button", () => {
            test("then it should pass both steps, and the page should have one click", async () => {
                const found = await onPage(NAMED_BY_ID_PAGE, async (session) => {
                    const filled = await failureCodeOf(session, fill(testId(FIELD), TYPED_TEXT));
                    return { filled, entered: await enterOutcomeIn(session) };
                });
                assert.deepEqual(found, { filled: null, entered: ONE_CLICK });
            });
        });

        describe("when a plan hovers over the button", () => {
            test("then it should pass the step", async () => {
                const failureCode = await onPage(NAMED_BY_ID_PAGE, (session) =>
                    failureCodeOf(session, { type: "hover", locator: testId(BUTTON) }),
                );
                assert.equal(failureCode, null);
            });
        });
    });

    describe("given a page whose frame holds a div whose id is the click check's name", () => {
        describe("when a plan enters the frame and clicks its button", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await onPage(framing(NAMED_BY_ID_PAGE), async (top) =>
                    clickOutcomeIn(await enterFrameOf(top)),
                );
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });
    });

    describe("given a page that adds a div with the click check's name when a button is clicked", () => {
        describe("when a plan clicks the button, the adding button, then the button again", () => {
            test("then it should pass all three clicks, with two clicks on the button", async () => {
                const found = await onPage(NAMED_AFTER_A_CLICK_PAGE, async (session) => {
                    const first = await clickOutcomeIn(session);
                    const adding = await failureCodeOf(session, click(testId(ADDER)));
                    const second = await clickOutcomeIn(session);
                    return { first, adding, second };
                });
                assert.deepEqual(found, {
                    first: ONE_CLICK,
                    adding: null,
                    second: { failureCode: null, tally: "2" },
                });
            });
        });
    });

    describe("given a page holding such a div, and a press that opened a dialog, which a plan has answered", () => {
        describe("when a plan presses Enter on the button", () => {
            test("then it should pass the step, and the page should have one click", async () => {
                const outcome = await onPage(NAMED_AND_ASKING_PAGE, async (session) => {
                    await failureCodeOf(session, click(testId(ASK)));
                    const answered = await session.act(
                        harness.actionStep({ type: "dialog", action: "accept" }),
                        allowEveryAction,
                    );
                    assert.deepEqual(
                        answered,
                        STEP_PASSED,
                        "a dialog opened, and the plan answered it",
                    );
                    return enterOutcomeIn(session);
                });
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });
    });

    describe("given a page holding such a div, and a cover that takes the next press", () => {
        describe("when a plan clicks the button", () => {
            test("then it should fail the step as not-actionable, with no click", async () => {
                const outcome = await onPage(NAMED_AND_COVERED_PAGE, clickOutcomeIn);
                assert.deepEqual(outcome, { failureCode: "not-actionable", tally: "0" });
            });
        });
    });
});
