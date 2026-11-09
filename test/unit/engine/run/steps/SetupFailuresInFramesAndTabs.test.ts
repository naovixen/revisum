// A setup step that could not do its work means the run could not test, wherever the step stands:
// the same failure must end the run in the same state at the top of the plan, in a frame and in a
// second tab. A check that fails stays a product failure in all three.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeSessionOnOrders, runOnFakeSession } from "../examples/RunOnFakeSession.ts";
import { OPEN_CART, READ_CART, unsafePlan, type JsonRecord } from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const STATUS: JsonRecord = { by: "testId", testId: "status" };
const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: STATUS,
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};

const PLACES: readonly {
    readonly name: string;
    readonly placed: (step: JsonRecord) => JsonRecord;
}[] = [
    { name: "at the top of the plan", placed: (step) => step },
    {
        name: "inside a frame",
        placed: (step) => ({
            type: "frame",
            locator: { by: "testId", testId: "cart-frame" },
            steps: [step],
        }),
    },
    {
        name: "inside a new tab",
        placed: (step) => ({ type: "newTab", url: "/cart", steps: [step] }),
    },
];

const FAILED_SCRIPTS: readonly {
    readonly name: string;
    readonly code: string;
    readonly answer: () => { readonly ok: true; readonly value: string };
}[] = [
    {
        name: "a result without the remembered field",
        code: "field-missing",
        answer: () => ({ ok: true, value: JSON.stringify({ other: 1 }) }),
    },
    {
        name: "a result that is not JSON",
        code: "script-result-invalid",
        answer: () => ({ ok: true, value: "not json" }),
    },
];

describe("Using the run", () => {
    for (const { name: place, placed } of PLACES) {
        for (const { name, code, answer } of FAILED_SCRIPTS) {
            describe(`given an evaluate ${place}`, () => {
                describe(`and its script gives ${name}`, () => {
                    describe("when the run ends", () => {
                        test(`then it should end Errored with ${code}`, async () => {
                            const { result } = await runOnFakeSession(
                                unsafePlan([OPEN_CART, placed(READ_CART)]),
                                {
                                    session: fakeSessionOnOrders({
                                        runScript: () => Promise.resolve(answer()),
                                    }),
                                },
                            );
                            assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                            assert.equal(result.steps[1]?.code, code, JSON.stringify(result.steps));
                        });
                    });
                });
            });
        }

        describe(`given a check ${place}`, () => {
            describe("and the page does not show what it expects", () => {
                describe("when the run ends", () => {
                    test("then it should end Failed", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, placed(FAILING_CHECK)]),
                        );
                        assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                        assert.equal(
                            result.steps[1]?.code,
                            "assertion-failed",
                            JSON.stringify(result.steps),
                        );
                    });
                });
            });
        });
    }
});
