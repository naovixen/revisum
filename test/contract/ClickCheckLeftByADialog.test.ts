// A dialog that opens during a press stops the driver reading its click check and sending the release,
// so the check's listeners stay on the page after the dialog is answered. Whatever a plan does next
// must still reach the page, in the document the press was in and through any later entry into its
// frame. What the press itself is judged to have done is not what these tests are about.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type DocumentSession } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { expectRead } from "#test-support/ExpectRead.ts";
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
    ASK,
    BUTTON,
    CHECKBOX,
    CONTROLS_PAGE,
    COVERED_AFTER_DIALOG_PAGE,
    DIALOG_AT_MOUSEDOWN_PAGE,
    DIALOG_AT_POINTERDOWN_PAGE,
    FIELD,
    FIRST_RADIO,
    FOCUS_GOES_TO_THE_BUTTON_PAGE,
    FRAME,
    HOVERED,
    LINK,
    PAGE_BUTTON_CLICKED,
    PAGE_CLICKER,
    DIALOG_ON_PRESS_PAGES,
    SECOND_RADIO_CHOSEN,
    SHOWN,
    SUBMITTED,
    TALLY,
    TICKED,
    TYPED_TEXT,
    framing,
} from "./DialogOnPressPages.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const NOT_ACTIONABLE = "not-actionable";

type ClickOutcome = { readonly failureCode: string | null; readonly tally: string };

const ONE_CLICK: ClickOutcome = { failureCode: null, tally: "1" };
const PRESS_REACHED_NOTHING: ClickOutcome = { failureCode: NOT_ACTIONABLE, tally: "0" };
const STEP_PASSED = { ok: true, value: undefined };

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, DIALOG_ON_PRESS_PAGES);
});
after(async () => {
    await harness.close();
});

const shownIn = async (document: DocumentSession, id: string): Promise<string | null> =>
    expectOneElement(await document.probe(harness.locator(testId(id)), null)).text;

const clickOutcomeIn = async (document: DocumentSession): Promise<ClickOutcome> => {
    const acted = await document.act(harness.actionStep(click(testId(BUTTON))), allowEveryAction);
    return {
        failureCode: acted.ok ? null : acted.error.code,
        tally: String(await shownIn(document, TALLY)),
    };
};

const answerDialogIn = async (document: DocumentSession): Promise<void> => {
    const answered = await document.act(
        harness.actionStep({ type: "dialog", action: "accept" }),
        allowEveryAction,
    );
    assert.deepEqual(answered, STEP_PASSED, "a dialog opened, and the plan answered it");
};

// The press's own verdict is left unread on purpose.
const pressOpeningADialogIn = async (document: DocumentSession): Promise<void> => {
    await document.act(harness.actionStep(click(testId(ASK))), allowEveryAction);
};

const dialogPressAnsweredIn = async (document: DocumentSession): Promise<void> => {
    await pressOpeningADialogIn(document);
    await answerDialogIn(document);
};

const leaveThePageAsItIs = (): Promise<void> => Promise.resolve();

const actIn = async (document: DocumentSession, step: JsonRecord): Promise<void> => {
    const acted = await document.act(harness.actionStep(step), allowEveryAction);
    assert.deepEqual(acted, STEP_PASSED, `the ${String(step.type)} step passes`);
};

const onPage = async <Value>(
    page: string,
    use: (session: DocumentSession) => Promise<Value>,
): Promise<Value> => {
    const opened = await ownDriverFor(TARGET).open(harness.target(TARGET), harness.environment());
    assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
    const session = opened.value;
    try {
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        return await use(session);
    } finally {
        await session.close();
    }
};

const enterFrameOf = async (document: DocumentSession): Promise<DocumentSession> => {
    const located = harness.locator(testId(FRAME));
    const inner = await document.frame(located);
    assert.ok(inner.ok, `the frame is found: ${JSON.stringify(inner)}`);
    return inner.value;
};

const inFrameAfterDialog = async <Value>(
    use: (documents: {
        readonly top: DocumentSession;
        readonly entry: DocumentSession;
    }) => Promise<Value>,
    framedPage = DIALOG_AT_POINTERDOWN_PAGE,
): Promise<Value> =>
    onPage(framing(framedPage), async (top) => {
        const entry = await enterFrameOf(top);
        await dialogPressAnsweredIn(entry);
        return use({ top, entry });
    });

const ENTER_ON_THE_BUTTON = press(testId(BUTTON), "Enter");

const tallyAfterEnterIn = async (document: DocumentSession): Promise<string | null> => {
    await actIn(document, ENTER_ON_THE_BUTTON);
    return shownIn(document, TALLY);
};

// What a plan can do next that is not a click, and what it should show on the page.
const NEXT_INPUTS: readonly {
    readonly name: string;
    readonly steps: readonly JsonRecord[];
    readonly shownAt: string;
    readonly shown: string;
    readonly effect: string;
}[] = [
    {
        name: "presses Enter on a focused button",
        steps: [ENTER_ON_THE_BUTTON],
        shownAt: TALLY,
        shown: "1",
        effect: "the page should have one click from the browser",
    },
    {
        name: "presses Space on a focused button",
        steps: [press(testId(BUTTON), "Space")],
        shownAt: TALLY,
        shown: "1",
        effect: "the page should have one click from the browser",
    },
    {
        name: "fills a field, then presses Enter in it to send the form",
        steps: [fill(testId(FIELD), TYPED_TEXT), press(testId(FIELD), "Enter")],
        shownAt: SHOWN,
        shown: SUBMITTED,
        effect: "the form should be sent",
    },
    {
        name: "presses Space on a checkbox",
        steps: [press(testId(CHECKBOX), "Space")],
        shownAt: SHOWN,
        shown: TICKED,
        effect: "the checkbox should change",
    },
    {
        name: "presses the down arrow on a radio button",
        steps: [press(testId(FIRST_RADIO), "ArrowDown")],
        shownAt: SHOWN,
        shown: SECOND_RADIO_CHOSEN,
        effect: "the next radio button should be chosen",
    },
    {
        name: "fills a field",
        steps: [fill(testId(FIELD), TYPED_TEXT)],
        shownAt: SHOWN,
        shown: TYPED_TEXT,
        effect: "the field should take the text",
    },
    {
        name: "presses a key that makes the page click a button of its own",
        steps: [press(testId(PAGE_CLICKER), "Escape")],
        shownAt: SHOWN,
        shown: PAGE_BUTTON_CLICKED,
        effect: "the page's button should have the page's click",
    },
    {
        name: "hovers over a button",
        steps: [{ type: "hover", locator: testId(BUTTON) }],
        shownAt: SHOWN,
        shown: HOVERED,
        effect: "the button should see the pointer",
    },
];

describe("Using the real browser driver", () => {
    for (const { pageState, earlier } of [
        { pageState: "a page with no dialog so far", earlier: leaveThePageAsItIs },
        {
            pageState: "a press that opened a dialog, which a plan has answered",
            earlier: dialogPressAnsweredIn,
        },
    ]) {
        describe(`given ${pageState}`, () => {
            for (const { name, steps, shownAt, shown, effect } of NEXT_INPUTS) {
                describe(`when a plan ${name}`, () => {
                    test(`then it should pass the step, and ${effect}`, async () => {
                        const found = await onPage(CONTROLS_PAGE, async (session) => {
                            await earlier(session);
                            for (const step of steps) {
                                await actIn(session, step);
                            }
                            return shownIn(session, shownAt);
                        });
                        assert.equal(found, shown);
                    });
                });
            }

            describe("when a plan presses Enter on a link", () => {
                test("then it should pass the step, and the browser should follow the link", async () => {
                    const url = await onPage(CONTROLS_PAGE, async (session) => {
                        await earlier(session);
                        await actIn(session, press(testId(LINK), "Enter"));
                        return expectRead(await session.page()).url;
                    });
                    assert.ok(url.endsWith("#followed"), url);
                });
            });
        });
    }

    for (const { pressesBefore, page, earlier } of [
        {
            pressesBefore: "a press that opened a dialog at mousedown",
            page: DIALOG_AT_MOUSEDOWN_PAGE,
            earlier: dialogPressAnsweredIn,
        },
        {
            pressesBefore: "two presses that each opened a dialog",
            page: DIALOG_AT_POINTERDOWN_PAGE,
            earlier: async (session: DocumentSession) => {
                await dialogPressAnsweredIn(session);
                await dialogPressAnsweredIn(session);
            },
        },
    ]) {
        describe(`given ${pressesBefore}, which a plan has answered`, () => {
            describe("when a plan presses Enter on a focused button", () => {
                test("then it should pass the step, and the page should have one click from the browser", async () => {
                    const tally = await onPage(page, async (session) => {
                        await earlier(session);
                        return tallyAfterEnterIn(session);
                    });
                    assert.equal(tally, "1");
                });
            });
        });
    }

    describe("given a press that opened a dialog, which a plan has answered", () => {
        describe("and a cover takes the next press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    const outcome = await onPage(COVERED_AFTER_DIALOG_PAGE, async (session) => {
                        await dialogPressAnsweredIn(session);
                        return clickOutcomeIn(session);
                    });
                    assert.deepEqual(outcome, PRESS_REACHED_NOTHING);
                });
            });
        });
    });

    describe("given a press in a frame that opened a dialog, which a plan has answered", () => {
        describe("when a plan clicks the button through the same entry into the frame", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await inFrameAfterDialog(({ entry }) => clickOutcomeIn(entry));
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });

        describe("when a plan presses Enter on the button through the same entry into the frame", () => {
            test("then it should pass the step, and the frame should have one click from the browser", async () => {
                const tally = await inFrameAfterDialog(({ entry }) => tallyAfterEnterIn(entry));
                assert.equal(tally, "1");
            });
        });

        describe("when a plan enters the frame again and clicks the button", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await inFrameAfterDialog(async ({ top }) =>
                    clickOutcomeIn(await enterFrameOf(top)),
                );
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });

        describe("when a plan enters the frame again and presses Enter on the button", () => {
            test("then it should pass the step, and the frame should have one click from the browser", async () => {
                const tally = await inFrameAfterDialog(async ({ top }) =>
                    tallyAfterEnterIn(await enterFrameOf(top)),
                );
                assert.equal(tally, "1");
            });
        });

        describe("when a plan clicks a button in the top document", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await inFrameAfterDialog(({ top }) => clickOutcomeIn(top));
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });

        describe("when a plan clicks a button in the top document, then enters the frame again and clicks its button", () => {
            test("then it should pass that click, with one click in the frame", async () => {
                const outcome = await inFrameAfterDialog(async ({ top }) => {
                    await clickOutcomeIn(top);
                    return clickOutcomeIn(await enterFrameOf(top));
                });
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });

        describe("and a cover in the frame takes the next press", () => {
            describe("when a plan enters the frame again and clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    const outcome = await inFrameAfterDialog(
                        async ({ top }) => clickOutcomeIn(await enterFrameOf(top)),
                        COVERED_AFTER_DIALOG_PAGE,
                    );
                    assert.deepEqual(outcome, PRESS_REACHED_NOTHING);
                });
            });
        });
    });

    describe("given a press in a frame that opened a dialog, which a plan has answered from the top document", () => {
        describe("when a plan enters the frame again and clicks the button", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await onPage(framing(DIALOG_AT_POINTERDOWN_PAGE), async (top) => {
                    await pressOpeningADialogIn(await enterFrameOf(top));
                    await answerDialogIn(top);
                    return clickOutcomeIn(await enterFrameOf(top));
                });
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });
    });

    describe("given a frame that gives its button focus when it gets focus, and a press in it that opened a dialog, which a plan has answered", () => {
        describe("when a plan presses Enter on the iframe from the top document", () => {
            test("then it should pass the step, and the frame's button should have one click", async () => {
                const tally = await inFrameAfterDialog(async ({ top, entry }) => {
                    await actIn(top, press(testId(FRAME), "Enter"));
                    return shownIn(entry, TALLY);
                }, FOCUS_GOES_TO_THE_BUTTON_PAGE);
                assert.equal(tally, "1");
            });
        });
    });

    describe("given two presses in a frame, through two entries, that each opened a dialog, which a plan has answered", () => {
        describe("when a plan enters the frame again and clicks the button", () => {
            test("then it should pass that click, with one click", async () => {
                const outcome = await inFrameAfterDialog(async ({ top }) => {
                    await dialogPressAnsweredIn(await enterFrameOf(top));
                    return clickOutcomeIn(await enterFrameOf(top));
                });
                assert.deepEqual(outcome, ONE_CLICK);
            });
        });
    });

    describe("given a press in the top document that opened a dialog, which a plan has answered", () => {
        describe("when a plan clicks the button in a frame, then the button in the top document", () => {
            test("then it should pass both clicks, with one click in each", async () => {
                const outcomes = await onPage(framing(DIALOG_AT_POINTERDOWN_PAGE), async (top) => {
                    await dialogPressAnsweredIn(top);
                    const inFrame = await clickOutcomeIn(await enterFrameOf(top));
                    return { inFrame, inTop: await clickOutcomeIn(top) };
                });
                assert.deepEqual(outcomes, { inFrame: ONE_CLICK, inTop: ONE_CLICK });
            });
        });
    });
});
