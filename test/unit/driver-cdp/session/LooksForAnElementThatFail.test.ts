// While an action waits for its element, the page may be navigating, and a document that goes away
// says nothing of what was in it: the wait reads that as "nothing yet" and looks again. Any other
// failure of a look says more than that: a driver bug or a command out of time must not hide behind
// "the element was not found".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { testId } from "#test-support/browser/RawPlan.ts";
import { fakeDocumentPorts } from "#test-support/fakes/session/FakeDocumentPorts.ts";
import {
    elementPageOperations,
    FAKE_PAGE_ELEMENT,
} from "#test-support/fakes/session/ElementPageOperations.ts";
import { inMockTime } from "#test-support/InMockTime.ts";
import {
    actionStep,
    allowing,
    failureCode,
} from "#test-support/session-contract/SessionUnderTest.ts";
import { CdpError } from "../../../../packages/driver-cdp/src/connection/CdpError.ts";
import { actionability } from "../../../../packages/driver-cdp/src/in-page/elements/Actionability.ts";
import { DocumentGone } from "../../../../packages/driver-cdp/src/page/failures/DocumentGone.ts";

const STEP_TIMEOUT_MILLISECONDS = 2000;
const CALL_FUNCTION = "Runtime.callFunctionOn";
const BUTTON = testId("save");

const DRIVER_BUG = new TypeError("handles is not iterable");
const COMMAND_OUT_OF_TIME = new CdpError(CALL_FUNCTION, "timeout after 15000 ms");
const CONTEXT_DESTROYED = new CdpError(CALL_FUNCTION, "Execution context was destroyed.");

const clickStep = () => actionStep({ type: "click", locator: BUTTON });

const FINDING_FAILURES: readonly {
    readonly name: string;
    readonly error: Error;
    readonly code: string;
}[] = [
    { name: "a driver's programming error", error: DRIVER_BUG, code: "not-actionable" },
    { name: "a command that ran out of time", error: COMMAND_OUT_OF_TIME, code: "timeout" },
];

const THE_DOCUMENT_HAS_GONE: readonly { readonly name: string; readonly error: Error }[] = [
    { name: "a document that has gone", error: new DocumentGone("the document has gone") },
    { name: "an execution context that was destroyed", error: CONTEXT_DESTROYED },
];

describe("Using a document's ports", () => {
    for (const { name, error, code } of FINDING_FAILURES) {
        describe(`given a look for the element that fails with ${name}`, () => {
            describe("when a click waits for it", () => {
                test(`then it should fail with ${code}, not as an element not found`, async (context) => {
                    const { value } = await inMockTime(context, () =>
                        fakeDocumentPorts({
                            timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                            operations: {
                                ...elementPageOperations(),
                                callForElements: () => Promise.reject(error),
                            },
                        }).act(clickStep(), allowing().guard),
                    );
                    assert.equal(failureCode(value), code);
                });
            });
        });

        describe(`given a check of the element that fails with ${name}`, () => {
            describe("when a click waits for it", () => {
                test(`then it should fail with ${code}, not as an element not found`, async (context) => {
                    const { value } = await inMockTime(context, () =>
                        fakeDocumentPorts({
                            timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                            operations: elementPageOperations([
                                [actionability, () => Promise.reject(error)],
                            ]),
                        }).act(clickStep(), allowing().guard),
                    );
                    assert.equal(failureCode(value), code);
                    assert.ok(value.ok === false, JSON.stringify(value));
                    assert.doesNotMatch(value.error.detail, /not attached/);
                });
            });
        });
    }

    for (const { name, error } of THE_DOCUMENT_HAS_GONE) {
        describe(`given a look for the element that fails with ${name}`, () => {
            describe("and an element the page shows by the next look", () => {
                describe("when a click waits for it", () => {
                    test("then it should look again, and act on the element", async (context) => {
                        let looks = 0;
                        const { value } = await inMockTime(context, () =>
                            fakeDocumentPorts({
                                timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                                operations: {
                                    ...elementPageOperations(),
                                    callForElements: () => {
                                        looks += 1;
                                        return looks === 1
                                            ? Promise.reject(error)
                                            : Promise.resolve([FAKE_PAGE_ELEMENT]);
                                    },
                                },
                            }).act(clickStep(), allowing().guard),
                        );
                        assert.deepEqual(value, { ok: true, value: undefined });
                    });
                });
            });

            describe("and an element that never comes", () => {
                describe("when a click waits for it", () => {
                    test("then it should end not-found", async (context) => {
                        const { value } = await inMockTime(context, () =>
                            fakeDocumentPorts({
                                timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                                operations: {
                                    ...elementPageOperations(),
                                    callForElements: () => Promise.reject(error),
                                },
                            }).act(clickStep(), allowing().guard),
                        );
                        assert.equal(failureCode(value), "not-found");
                    });
                });
            });
        });
    }
});
