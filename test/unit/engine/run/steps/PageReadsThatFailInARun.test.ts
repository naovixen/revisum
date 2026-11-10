// A step that reads the whole page says what stopped the read. A dialog and a crash are the page's to
// answer for, and any other failure is the adapter's, whose words stay out of the result. None of them
// is worth waiting out: a read that failed is not tried again.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    PageReadFailureCode,
    success,
    type PageReadFailure,
    type Session,
} from "@revisum/engine";
import { recordCalls, type Recorded } from "#test-support/fakes/RecordCalls.ts";
import { fakeSession, type FakeSession } from "#test-support/fakes/session/FakeSession.ts";
import {
    fakeSessionOnOrders,
    runOnFakeSession,
    stepSummaries,
} from "../examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const WHAT_THE_DRIVER_SAID = "the driver's own words about the read";

const FAILED_READS: readonly {
    readonly code: PageReadFailureCode;
    readonly stepCode: string;
    readonly state: string;
}[] = [
    { code: PageReadFailureCode.DialogOpen, stepCode: "dialog-open", state: "Failed" },
    { code: PageReadFailureCode.TargetCrashed, stepCode: "target-crashed", state: "Failed" },
    { code: PageReadFailureCode.PageUnreadable, stepCode: "adapter-error", state: "Errored" },
];

const READING_STEPS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly read: "page" | "audit" | "screenshot";
}[] = [
    {
        name: "an expectPage",
        step: {
            type: "expectPage",
            assert: { kind: "title", value: "Orders" },
            criterionId: "cart.title-shown",
        },
        read: "page",
    },
    { name: "an a11yAudit", step: { type: "a11yAudit", mode: "report" }, read: "audit" },
    { name: "a capture", step: { type: "capture", name: "cart" }, read: "screenshot" },
];

const sessionWhoseReadFails = (
    read: "page" | "audit" | "screenshot",
    code: PageReadFailureCode,
): Recorded<Session> => {
    const readFailure: PageReadFailure = { code, detail: WHAT_THE_DRIVER_SAID };
    return recordCalls(
        fakeSessionOnOrders({ [read]: () => Promise.resolve(failure(readFailure)) }),
    );
};

// Told nothing about its reads, so what it gives is what the fake gives of a page a dialog holds.
const sessionHeldByADialogOnceLoaded = (): FakeSession => {
    const session: FakeSession = fakeSession({
        navigate: () => {
            session.openDialog("Keep the draft?");
            return Promise.resolve(success(undefined));
        },
    });
    return session;
};

describe("Using the run", () => {
    for (const { name, step, read } of READING_STEPS) {
        for (const { code, stepCode, state } of FAILED_READS) {
            describe(`given ${name} whose read of the page fails with ${code}`, () => {
                describe("when the run ends", () => {
                    test(`then it should fail the step with ${stepCode}, skip the rest and end ${state}`, async () => {
                        const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, step]), {
                            session: sessionWhoseReadFails(read, code),
                        });
                        assert.deepEqual(
                            { state: result.state, steps: stepSummaries(result) },
                            {
                                state,
                                steps: [
                                    ["passed", undefined],
                                    ["failed", stepCode],
                                    ["skipped", undefined],
                                ],
                            },
                        );
                    });

                    test("then it should have read once, and keep the driver's words out of the result", async () => {
                        const session = sessionWhoseReadFails(read, code);
                        const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, step]), {
                            session,
                        });
                        assert.equal(session.calls.count(read), 1);
                        assert.equal(
                            JSON.stringify(result.steps).includes(WHAT_THE_DRIVER_SAID),
                            false,
                        );
                    });
                });
            });
        }
    }

    describe("given a fake session whose page a dialog holds", () => {
        for (const { name, step } of READING_STEPS) {
            describe(`when ${name} runs`, () => {
                test("then it should fail with dialog-open", async () => {
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, step]), {
                        session: sessionHeldByADialogOnceLoaded(),
                    });
                    assert.equal(result.steps[1]?.code, "dialog-open");
                });
            });
        }
    });
});
