// A form's named inputs are properties of the form, and they hide the methods of the same name. That is
// as true in the driver's own script world as in the page's, so the click check must not be thrown by
// them: a press it fails to judge must not read as one that worked, nor one that failed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { DocumentSession } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { readableProbe } from "#test-support/browser/ReadableProbe.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, fill, press, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import {
    BUTTON,
    CLICKED_FORM,
    COVER_HOLDING_CLOSEST_PAGE,
    COVER_HOLDING_PLAIN_PAGE,
    COVER_REMOVING_THE_BUTTON_HOLDING_CLOSEST_PAGE,
    COVER_REMOVING_THE_BUTTON_HOLDING_PLAIN_PAGE,
    DIALOG_ON_PRESS_PAGES,
    FIELD,
    FORM_INPUT_NAME_HIDING_NOTHING,
    FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD,
    HOVERED,
    NOTHING_SHOWN,
    SHOWN,
    TALLY,
    TYPED_TEXT,
    askingFormHoldingInputPage,
    divIdentifiedAsPage,
    formHoldingInputPage,
} from "./DialogOnPressPages.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const NOT_ACTIONABLE = "not-actionable";
const LANDED_ELSEWHERE = "the click landed on another element";

type Failure = { readonly code: string; readonly detail: string } | null;

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, DIALOG_ON_PRESS_PAGES);
});
after(async () => {
    await harness.close();
});

const shownIn = async (document: DocumentSession, id: string): Promise<string | null> =>
    readableProbe(await document.probe(harness.locator(testId(id)))).text;

const failureOf = async (document: DocumentSession, step: JsonRecord): Promise<Failure> => {
    const acted = await document.act(harness.actionStep(step), allowEveryAction);
    return acted.ok ? null : { code: acted.error.code, detail: acted.error.detail };
};

const answerDialogIn = async (document: DocumentSession): Promise<void> => {
    const answered = await failureOf(document, { type: "dialog", action: "accept" });
    assert.equal(answered, null, "a dialog opened, and the plan answered it");
};

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

const CLICK_THE_FORM = click(testId(CLICKED_FORM));

const LATER_INPUTS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly shownAt: string;
    readonly shown: string;
    readonly effect: string;
}[] = [
    {
        name: "presses Enter on a button",
        step: press(testId(BUTTON), "Enter"),
        shownAt: TALLY,
        shown: "1",
        effect: "the page should have one click",
    },
    {
        name: "clicks a button",
        step: click(testId(BUTTON)),
        shownAt: TALLY,
        shown: "1",
        effect: "the page should have one click",
    },
    {
        name: "hovers over a button",
        step: { type: "hover", locator: testId(BUTTON) },
        shownAt: SHOWN,
        shown: HOVERED,
        effect: "the button should see the pointer",
    },
    {
        name: "fills a field",
        step: fill(testId(FIELD), TYPED_TEXT),
        shownAt: SHOWN,
        shown: TYPED_TEXT,
        effect: "the field should take the text",
    },
];

describe("Using the real browser driver", () => {
    for (const inputName of [
        FORM_INPUT_NAME_HIDING_NOTHING,
        ...FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD,
    ]) {
        describe(`given a form holding an input named ${inputName}`, () => {
            describe("when a plan clicks the form", () => {
                test("then it should pass the step", async () => {
                    const failure = await onPage(formHoldingInputPage(inputName), (session) =>
                        failureOf(session, CLICK_THE_FORM),
                    );
                    assert.equal(failure, null);
                });
            });

            describe("and a press on the form that opens a dialog", () => {
                describe("when a plan clicks the form and answers the dialog", () => {
                    test("then it should pass both steps", async () => {
                        const failure = await onPage(
                            askingFormHoldingInputPage(inputName),
                            async (session) => {
                                const clicked = await failureOf(session, CLICK_THE_FORM);
                                await answerDialogIn(session);
                                return clicked;
                            },
                        );
                        assert.equal(failure, null);
                    });
                });
            });

            for (const { name, step, shownAt, shown, effect } of LATER_INPUTS) {
                describe(`when a plan clicks the form, then ${name}`, () => {
                    test(`then it should pass the later step, and ${effect}`, async () => {
                        const found = await onPage(
                            formHoldingInputPage(inputName),
                            async (session) => {
                                await failureOf(session, CLICK_THE_FORM);
                                const failure = await failureOf(session, step);
                                return { failure, shown: await shownIn(session, shownAt) };
                            },
                        );
                        assert.deepEqual(found, { failure: null, shown });
                    });
                });

                describe(`when a plan clicks the form, answers the dialog that opens at the press, then ${name}`, () => {
                    test(`then it should pass the later step, and ${effect}`, async () => {
                        const found = await onPage(
                            askingFormHoldingInputPage(inputName),
                            async (session) => {
                                await failureOf(session, CLICK_THE_FORM);
                                await answerDialogIn(session);
                                const failure = await failureOf(session, step);
                                return { failure, shown: await shownIn(session, shownAt) };
                            },
                        );
                        assert.deepEqual(found, { failure: null, shown });
                    });
                });
            }
        });
    }

    for (const id of FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD) {
        describe(`given a page holding a div whose id is ${id}`, () => {
            describe("when a plan clicks a button", () => {
                test("then it should pass the step, with one click", async () => {
                    const found = await onPage(divIdentifiedAsPage(id), async (session) => ({
                        failure: await failureOf(session, click(testId(BUTTON))),
                        tally: await shownIn(session, TALLY),
                    }));
                    assert.deepEqual(found, { failure: null, tally: "1" });
                });
            });
        });
    }

    for (const { inputName, removingPage, leavingPage } of [
        {
            inputName: "plain",
            removingPage: COVER_REMOVING_THE_BUTTON_HOLDING_PLAIN_PAGE,
            leavingPage: COVER_HOLDING_PLAIN_PAGE,
        },
        {
            inputName: "closest",
            removingPage: COVER_REMOVING_THE_BUTTON_HOLDING_CLOSEST_PAGE,
            leavingPage: COVER_HOLDING_CLOSEST_PAGE,
        },
    ]) {
        describe(`given a covering form holding a hidden input named ${inputName}`, () => {
            for (const { cover, page } of [
                { cover: "whose click handler removes the button", page: removingPage },
                { cover: "whose click handler leaves the button", page: leavingPage },
            ]) {
                describe(`and ${cover}`, () => {
                    describe("when a plan clicks the button", () => {
                        test("then it should fail as landing on another element, with the cover not clicked and no click on the button", async () => {
                            const found = await onPage(page, async (session) => ({
                                failure: await failureOf(session, click(testId(BUTTON))),
                                shown: await shownIn(session, SHOWN),
                                tally: await shownIn(session, TALLY),
                            }));
                            assert.deepEqual(found, {
                                failure: { code: NOT_ACTIONABLE, detail: LANDED_ELSEWHERE },
                                shown: NOTHING_SHOWN,
                                tally: "0",
                            });
                        });
                    });
                });
            }
        });
    }
});
