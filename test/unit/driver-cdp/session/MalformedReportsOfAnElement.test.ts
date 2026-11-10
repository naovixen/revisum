// What an in-page function reports is outside data, read a field at a time. A field of the wrong shape
// says the report cannot be trusted: reading it as "no link" would let the runtime guard judge a click
// on what the page failed to report. A centre that cannot be read is no state of the element that the
// step can name either.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { testId } from "#test-support/browser/RawPlan.ts";
import { fakeDocumentPorts } from "#test-support/fakes/session/FakeDocumentPorts.ts";
import { elementPageOperations } from "#test-support/fakes/session/ElementPageOperations.ts";
import { inMockTime } from "#test-support/InMockTime.ts";
import { actionStep, allowing } from "#test-support/session-contract/SessionUnderTest.ts";
import { actionability } from "../../../../packages/driver-cdp/src/in-page/elements/Actionability.ts";
import { guardDetails } from "../../../../packages/driver-cdp/src/in-page/elements/GuardDetails.ts";
import { HitCheckOutcome } from "../../../../packages/driver-cdp/src/page/checks/HitChecks.ts";

const STEP_TIMEOUT_MILLISECONDS = 2000;
const BUTTON = testId("save");

const report = (fields: Readonly<Record<string, unknown>>): string =>
    JSON.stringify({
        box: { x: 0, y: 0, width: 10, height: 10 },
        formSubmitName: null,
        linkUrl: null,
        testId: null,
        ...fields,
    });

const clickStep = () => actionStep({ type: "click", locator: BUTTON });

const WRONG_SHAPES = [
    { name: "a link URL that is a number", fields: { linkUrl: 7 } },
    { name: "a form submit name that is a number", fields: { formSubmitName: 7 } },
    { name: "a test id that is an object", fields: { testId: {} } },
    { name: "a box that is a number", fields: { box: 7 } },
];

// A page whose guard details say this, counting the presses a click sends.
function pageReportingGuardDetails(text: string) {
    const presses = { count: 0 };
    return {
        presses,
        document: fakeDocumentPorts({
            timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
            operations: elementPageOperations([[guardDetails, () => Promise.resolve(text)]]),
            hitChecks: {
                around: () => {
                    presses.count += 1;
                    return Promise.resolve(HitCheckOutcome.Hit);
                },
            },
        }),
    };
}

describe("Using a document's ports", () => {
    for (const { name, fields } of WRONG_SHAPES) {
        describe(`given guard details with ${name}`, () => {
            describe("when a click is judged", () => {
                test("then it should fail as a malformed reply, without asking the guard or pressing", async (context) => {
                    const { guard, asked } = allowing();
                    const { document, presses } = pageReportingGuardDetails(report(fields));
                    const { value } = await inMockTime(context, () =>
                        document.act(clickStep(), guard),
                    );
                    assert.ok(value.ok === false, JSON.stringify(value));
                    assert.match(value.error.detail, /malformed/i);
                    assert.deepEqual(
                        { asked: asked.length, presses: presses.count },
                        { asked: 0, presses: 0 },
                    );
                });
            });
        });
    }

    describe("given guard details that say nothing is shown", () => {
        describe("when a click is judged", () => {
            test("then it should ask the guard and press", async (context) => {
                const { guard, asked } = allowing();
                const { document, presses } = pageReportingGuardDetails(report({}));
                const { value } = await inMockTime(context, () => document.act(clickStep(), guard));
                assert.deepEqual(value, { ok: true, value: undefined });
                assert.deepEqual(
                    { asked: asked.length, presses: presses.count },
                    { asked: 1, presses: 1 },
                );
            });
        });
    });

    describe("given an element every state is true of, with a centre that cannot be read", () => {
        describe("when a click waits for it", () => {
            test("then it should say the centre is unreadable, not name an unknown state", async (context) => {
                const reported = JSON.stringify({
                    attached: true,
                    visible: true,
                    stable: true,
                    receivesEvents: true,
                    centre: null,
                });
                const { value } = await inMockTime(context, () =>
                    fakeDocumentPorts({
                        timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                        operations: elementPageOperations([
                            [actionability, () => Promise.resolve(reported)],
                        ]),
                    }).act(clickStep(), allowing().guard),
                );
                assert.ok(value.ok === false, JSON.stringify(value));
                assert.doesNotMatch(value.error.detail, /unknown/i);
                assert.match(value.error.detail, /unreadable/i);
            });
        });
    });
});
