// Request and response checks read what the session has already recorded, so nothing about them
// notices a dead browser. A final check that passes from memory after the browser died would report
// a pass on a page nobody could see, so it must say target-crashed instead.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    fakeNetwork,
    fakeSessionOnOrders,
    likesExchange,
    runOnFakeSession,
    stepSummaries,
} from "../examples/RunOnFakeSession.ts";
import {
    CLOSING_CHECK,
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const HOVER_MENU: JsonRecord = { type: "hover", locator: { by: "testId", testId: "menu" } };

const expectRequests = (count: JsonRecord): JsonRecord => ({
    type: "expectRequests",
    request: "likes",
    count,
    criterionId: "likes.count-checked",
});
const expectResponse = (assertion: JsonRecord): JsonRecord => ({
    type: "expectResponse",
    request: "likes",
    assert: assertion,
    criterionId: "likes.answer-checked",
});
const REMEMBER_FIRST_NAME: JsonRecord = {
    type: "remember",
    name: "firstName",
    from: { response: "likes", field: "firstLiker", read: "text" },
};

// A plan with no check after the last step, so that step is what decides the run. A remember is no
// check, and a plan must hold one, so a check follows it.
const planEndingWith = (finalStep: JsonRecord): JsonRecord => ({
    ...unsafePlan([]),
    steps: [
        OPEN_CART,
        HOVER_MENU,
        finalStep,
        ...(finalStep === REMEMBER_FIRST_NAME ? [CLOSING_CHECK] : []),
    ],
});

const FINAL_CHECKS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly exchanges: readonly number[];
}[] = [
    { name: "expectRequests equals 0", step: expectRequests({ equals: 0 }), exchanges: [] },
    { name: "expectRequests equals 1", step: expectRequests({ equals: 1 }), exchanges: [200] },
    { name: "expectRequests atMost 1", step: expectRequests({ atMost: 1 }), exchanges: [] },
    { name: "expectRequests atLeast 1", step: expectRequests({ atLeast: 1 }), exchanges: [200] },
    {
        name: "expectResponse statusEquals 200",
        step: expectResponse({ kind: "statusEquals", value: 200 }),
        exchanges: [200],
    },
    {
        name: "expectResponse fieldEquals",
        step: expectResponse({ kind: "fieldEquals", field: "firstLiker", value: "Ada" }),
        exchanges: [200],
    },
    { name: "a remember from the response", step: REMEMBER_FIRST_NAME, exchanges: [200] },
];

// A session whose browser dies as the step before the final one ends, if `isDying` says so.
function sessionThatMayDie(exchanges: readonly number[], isDying: boolean) {
    let isDead = false;
    return fakeSessionOnOrders({
        network: fakeNetwork(exchanges.map((status) => likesExchange(status, "Ada"))),
        crashed: () => isDead,
        act: () => {
            isDead = isDying;
            return Promise.resolve({ ok: true, value: undefined });
        },
    });
}

describe("Using the run", () => {
    for (const check of FINAL_CHECKS) {
        describe(`given a plan that ends with ${check.name}`, () => {
            describe("and the browser dies just before that step", () => {
                describe("when the run ends", () => {
                    test("then it should fail the step with target-crashed", async () => {
                        const { result } = await runOnFakeSession(planEndingWith(check.step), {
                            session: sessionThatMayDie(check.exchanges, true),
                        });
                        assert.deepEqual(
                            { state: result.state, steps: stepSummaries(result).slice(0, 3) },
                            {
                                state: "Failed",
                                steps: [
                                    ["passed", undefined],
                                    ["passed", undefined],
                                    ["failed", "target-crashed"],
                                ],
                            },
                        );
                    });
                });
            });

            describe("and the browser stays alive", () => {
                describe("when the run ends", () => {
                    test("then it should pass the step", async () => {
                        const { result } = await runOnFakeSession(planEndingWith(check.step), {
                            session: sessionThatMayDie(check.exchanges, false),
                        });
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }
});
