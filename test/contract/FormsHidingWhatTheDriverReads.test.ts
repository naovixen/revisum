// A form's named inputs are properties of the form, and they hide whatever it inherits, in the driver's
// script world as in the page's. A hostile page can name an input after anything the driver reads, and
// that must not stop a step, send it round in circles or take a name from the guard.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ActionGuard, DocumentSession, ResolvedElement } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { click, label, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import {
    BUTTON_IN_THE_FORM,
    BUTTON_IN_THE_FORM_CLICKED,
    BUTTON_IN_THE_FORM_NAME,
    CLICKED_FORM,
    DIALOG_ON_PRESS_PAGES,
    FIELD,
    FORM_INPUT_NAME_HIDING_NOTHING,
    FORM_INPUT_NAMES_HIDING_WHAT_THE_DRIVER_READS,
    FORM_LABEL,
    FORM_SUBMIT_NAME,
    SHOWN,
    formHoldingButtonPage,
    formWithSubmitPage,
} from "./DialogOnPressPages.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, DIALOG_ON_PRESS_PAGES);
});
after(async () => {
    await harness.close();
});

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

const failureCodeOf = async (
    session: DocumentSession,
    step: JsonRecord,
): Promise<string | null> => {
    const acted = await session.act(harness.actionStep(step), allowEveryAction);
    return acted.ok ? null : acted.error.code;
};

const shownOn = async (session: DocumentSession): Promise<string> =>
    expectOneElement(await session.probe(harness.locator(testId(SHOWN)), null)).text;

const CLICKS_ON_THE_FORM: readonly { readonly found: string; readonly locator: JsonRecord }[] = [
    { found: "its test id", locator: testId(CLICKED_FORM) },
    { found: "its label", locator: label(FORM_LABEL) },
];

const NOT_HIDDEN_FIRST = [
    FORM_INPUT_NAME_HIDING_NOTHING,
    ...FORM_INPUT_NAMES_HIDING_WHAT_THE_DRIVER_READS,
];

describe("Using the real browser driver", () => {
    for (const inputName of NOT_HIDDEN_FIRST) {
        describe(`given a form holding an input named ${inputName}`, () => {
            for (const { found, locator } of CLICKS_ON_THE_FORM) {
                describe(`when a plan clicks the form, found by ${found}`, () => {
                    test("then it should pass the step", async () => {
                        const failure = await onPage(formHoldingButtonPage(inputName), (session) =>
                            failureCodeOf(session, click(locator)),
                        );
                        assert.equal(failure, null);
                    });
                });
            }

            describe("when a plan reads the form", () => {
                test("then it should find the one form, shown", async () => {
                    const probe = await onPage(formHoldingButtonPage(inputName), async (session) =>
                        expectOneElement(
                            await session.probe(harness.locator(testId(CLICKED_FORM)), null),
                        ),
                    );
                    assert.deepEqual(
                        { count: probe.count, visible: probe.visible, enabled: probe.enabled },
                        { count: 1, visible: true, enabled: true },
                    );
                });
            });

            describe("when a plan clicks a button in the form, found by its text", () => {
                test("then it should reach the button, with the form on its way up", async () => {
                    const found = await onPage(
                        formHoldingButtonPage(inputName),
                        async (session) => ({
                            failure: await failureCodeOf(
                                session,
                                click({ by: "text", text: BUTTON_IN_THE_FORM_NAME }),
                            ),
                            shown: await shownOn(session),
                        }),
                    );
                    assert.deepEqual(found, {
                        failure: null,
                        shown: BUTTON_IN_THE_FORM_CLICKED,
                    });
                });
            });

            describe("when a plan clicks a button in the form, found by its test id", () => {
                test("then it should reach the button", async () => {
                    const found = await onPage(
                        formHoldingButtonPage(inputName),
                        async (session) => ({
                            failure: await failureCodeOf(
                                session,
                                click(testId(BUTTON_IN_THE_FORM)),
                            ),
                            shown: await shownOn(session),
                        }),
                    );
                    assert.deepEqual(found, {
                        failure: null,
                        shown: BUTTON_IN_THE_FORM_CLICKED,
                    });
                });
            });

            describe("when a plan clicks a field of a form with a submit button", () => {
                test("then it should show the guard the submit button's name", async () => {
                    const asked: ResolvedElement[] = [];
                    const noting: ActionGuard = (element) => {
                        asked.push(element);
                        return { kind: "deny", rule: "irreversible-action", stepIndex: 1 };
                    };
                    const acted = await onPage(formWithSubmitPage(inputName), (session) =>
                        session.act(harness.actionStep(click(testId(FIELD))), noting),
                    );
                    assert.equal(acted.ok, false);
                    assert.equal(asked[0]?.formSubmitName, FORM_SUBMIT_NAME);
                });
            });
        });
    }
});
