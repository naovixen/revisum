// The requests a plan checks are observed from before its first step, so what a page sends as it
// loads counts too. If that cannot start, nothing the plan checks can be believed: the first step
// stands for the failure, so the result says why nothing ran, and no step touches the page.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { failure, success, type NetworkPort } from "@revisum/engine";
import {
    fakeNetwork,
    fakeSessionOnOrders,
    runOnFakeSession,
    stepSummaries,
} from "../../examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../../plan/unsafe-features/examples/UnsafePlan.ts";
import { DriverErrorCode } from "@revisum/contracts";

const LIKES_CHECK: JsonRecord = {
    type: "expectRequests",
    request: "likes",
    count: { equals: 0 },
    criterionId: "likes.count-checked",
};

const FAILED_OBSERVES: readonly {
    readonly name: string;
    readonly observe: NetworkPort["observe"];
}[] = [
    {
        name: "gives a failure",
        observe: () =>
            Promise.resolve(
                failure({ code: DriverErrorCode.NavigationFailed, detail: "the port is closed" }),
            ),
    },
    {
        name: "rejects",
        observe: () => Promise.reject(new Error("the port is closed")),
    },
];

const sessionWithObserve = (context: TestContext, observe: NetworkPort["observe"]) => {
    const navigate = context.mock.fn(() => Promise.resolve(success(undefined)));
    const spiedObserve = context.mock.fn(observe);
    const session = fakeSessionOnOrders({
        navigate,
        network: { ...fakeNetwork(), observe: spiedObserve },
    });
    return { session, navigate, spiedObserve };
};

describe("Using the run", () => {
    for (const { name, observe } of FAILED_OBSERVES) {
        describe(`given a plan that checks a request, and observing it ${name}`, () => {
            describe("when the run ends", () => {
                test("then it should record adapter-error on the first step, skip the rest and end Errored", async (context) => {
                    const { session } = sessionWithObserve(context, observe);
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, LIKES_CHECK]),
                        { session },
                    );
                    assert.deepEqual(
                        { state: result.state, steps: stepSummaries(result) },
                        {
                            state: "Errored",
                            steps: [
                                ["failed", "adapter-error"],
                                ["skipped", undefined],
                                ["skipped", undefined],
                            ],
                        },
                    );
                });

                test("then it should not touch the page", async (context) => {
                    const { session, navigate } = sessionWithObserve(context, observe);
                    await runOnFakeSession(unsafePlan([OPEN_CART, LIKES_CHECK]), { session });
                    assert.equal(navigate.mock.callCount(), 0);
                });
            });
        });
    }

    describe("given a plan that checks a request, and observing it works", () => {
        describe("when the run ends", () => {
            test("then it should observe the request once and run every step", async (context) => {
                const { session, navigate, spiedObserve } = sessionWithObserve(context, () =>
                    Promise.resolve(success(undefined)),
                );
                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, LIKES_CHECK]), {
                    session,
                });
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(spiedObserve.mock.callCount(), 1);
                assert.equal(spiedObserve.mock.calls[0]?.arguments[0], "likes");
                assert.equal(navigate.mock.callCount(), 1);
            });
        });
    });
});
