// An adapter that throws, or a read of the page that says only that it could not read it, must leave a
// full account in the result: the step is recorded with adapter-error, every later step is marked
// skipped, and the run ends Errored. A tab that fails to close afterwards must not take the place of
// what its steps found.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure } from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession, stepSummaries } from "./RunOnFakeSession.ts";
import { CLOSING_CHECK, OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";

const ADAPTER_BROKE = "the adapter broke";
const breaks = (): Promise<never> => Promise.reject(new Error(ADAPTER_BROKE));
const cannotRead = () =>
    Promise.resolve(failure({ code: "page-unreadable", detail: ADAPTER_BROKE } as const));

const STATUS: JsonRecord = { by: "testId", testId: "status" };
const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: STATUS,
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};
const PASSING_CHECK: JsonRecord = {
    type: "expect",
    locator: STATUS,
    assert: { kind: "textEquals", value: "Ready" },
    criterionId: "status.text-shown",
};
const newTabHolding = (step: JsonRecord): JsonRecord => ({
    type: "newTab",
    url: "/cart",
    steps: [step],
});

const THROWING_STEPS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly session: () => ReturnType<typeof fakeSessionOnOrders>;
}[] = [
    {
        name: "an expect whose probe",
        step: PASSING_CHECK,
        session: () => fakeSessionOnOrders({ probe: breaks }),
    },
    {
        name: "a click whose action",
        step: { type: "click", locator: { by: "role", role: "button", name: "Pay" } },
        session: () => fakeSessionOnOrders({ act: breaks }),
    },
    {
        name: "a navigate whose load",
        step: { type: "navigate", url: "/orders" },
        session: () => {
            let loads = 0;
            return fakeSessionOnOrders({
                navigate: () => {
                    loads += 1;
                    return loads > 1 ? breaks() : Promise.resolve({ ok: true, value: undefined });
                },
            });
        },
    },
];

const UNREADABLE_STEPS: typeof THROWING_STEPS = [
    {
        name: "a capture whose screenshot",
        step: { type: "capture", name: "cart" },
        session: () => fakeSessionOnOrders({ screenshot: cannotRead }),
    },
    {
        name: "an a11yAudit whose audit",
        step: { type: "a11yAudit", mode: "report" },
        session: () => fakeSessionOnOrders({ audit: cannotRead }),
    },
    {
        name: "an expectPage whose page read",
        step: {
            type: "expectPage",
            assert: { kind: "title", value: "Orders" },
            criterionId: "cart.title-shown",
        },
        session: () => fakeSessionOnOrders({ page: cannotRead }),
    },
];

// A session whose tabs fail to close.
const sessionWithTabThatWillNotClose = () => {
    const tab = fakeSessionOnOrders({ close: breaks });
    return fakeSessionOnOrders({ newTab: () => Promise.resolve({ ok: true, value: tab }) });
};

describe("Using the run", () => {
    for (const { name, step, session } of [
        ...THROWING_STEPS.map((given) => ({ ...given, name: `${given.name} throws` })),
        ...UNREADABLE_STEPS.map((given) => ({ ...given, name: `${given.name} cannot read` })),
    ]) {
        describe(`given ${name}`, () => {
            describe("and steps follow it", () => {
                describe("when the run ends", () => {
                    test("then it should record the step with adapter-error, skip the rest and end Errored", async () => {
                        const raw = unsafePlan([OPEN_CART, step, CLOSING_CHECK]);
                        const { result } = await runOnFakeSession(raw, { session: session() });
                        assert.deepEqual(
                            { state: result.state, steps: stepSummaries(result) },
                            {
                                state: "Errored",
                                steps: [
                                    ["passed", undefined],
                                    ["failed", "adapter-error"],
                                    ["skipped", undefined],
                                    ["skipped", undefined],
                                ],
                            },
                        );
                    });

                    test("then it should keep the adapter's text out of the result", async () => {
                        const raw = unsafePlan([OPEN_CART, step, CLOSING_CHECK]);
                        const { result } = await runOnFakeSession(raw, { session: session() });
                        assert.equal(JSON.stringify(result.steps).includes(ADAPTER_BROKE), false);
                    });
                });
            });
        });
    }

    describe("given a step inside a frame cannot read the page", () => {
        describe("when the run ends", () => {
            test("then it should record the frame step with adapter-error and end Errored", async () => {
                const frame: JsonRecord = {
                    type: "frame",
                    locator: { by: "testId", testId: "cart-frame" },
                    steps: [{ type: "capture", name: "cart" }],
                };
                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, frame]), {
                    session: fakeSessionOnOrders({ screenshot: cannotRead }),
                });
                assert.deepEqual(
                    { state: result.state, steps: stepSummaries(result) },
                    {
                        state: "Errored",
                        steps: [
                            ["passed", undefined],
                            ["failed", "adapter-error"],
                            ["skipped", undefined],
                        ],
                    },
                );
            });
        });
    });

    describe("given a new tab whose check fails", () => {
        describe("and the tab fails to close", () => {
            describe("when the run ends", () => {
                test("then it should report the check's own failure", async () => {
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding(FAILING_CHECK)]),
                        { session: sessionWithTabThatWillNotClose() },
                    );
                    assert.deepEqual(
                        { state: result.state, steps: stepSummaries(result) },
                        {
                            state: "Failed",
                            steps: [
                                ["passed", undefined],
                                ["failed", "assertion-failed"],
                                ["skipped", undefined],
                            ],
                        },
                    );
                });
            });
        });

        describe("and the tab closes", () => {
            describe("when the run ends", () => {
                test("then it should report the check's own failure", async () => {
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding(FAILING_CHECK)]),
                    );
                    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                    assert.equal(result.steps[1]?.code, "assertion-failed");
                });
            });
        });
    });

    describe("given a new tab whose check passes", () => {
        describe("and the tab fails to close", () => {
            describe("when the run ends", () => {
                test("then it should record the step with adapter-error and end Errored", async () => {
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding(PASSING_CHECK)]),
                        { session: sessionWithTabThatWillNotClose() },
                    );
                    assert.deepEqual(
                        { state: result.state, steps: stepSummaries(result) },
                        {
                            state: "Errored",
                            steps: [
                                ["passed", undefined],
                                ["failed", "adapter-error"],
                                ["skipped", undefined],
                            ],
                        },
                    );
                });
            });
        });
    });

    describe("given an adapter that never throws", () => {
        describe("when the run ends", () => {
            test("then it should record every step as passed", async () => {
                const { result } = await runOnFakeSession(
                    unsafePlan([
                        OPEN_CART,
                        { type: "capture", name: "cart" },
                        newTabHolding(PASSING_CHECK),
                    ]),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(result.steps.length, 4);
            });
        });
    });
});
