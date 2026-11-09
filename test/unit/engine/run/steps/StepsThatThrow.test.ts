// An adapter that throws, or a read of the page that says only that it could not read it, must leave a
// full account in the result: the step is recorded with adapter-error, every later step is marked
// skipped, and the run ends Errored. A tab's or a session's close never rejects: one that breaks that
// promise keeps what the steps found, and is reported as a close failure in the log.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, type RunEventSink, type Session, type SessionTab } from "@revisum/engine";
import { fakeSession } from "#test-support/fakes/session/FakeSession.ts";
import { fakeSessionOnOrders, runOnFakeSession, stepSummaries } from "../examples/RunOnFakeSession.ts";
import { CLOSING_CHECK, OPEN_CART, unsafePlan, type JsonRecord } from "../../plan/unsafe-features/examples/UnsafePlan.ts";

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
        name: "a capture whose screenshot",
        step: { type: "capture", name: "cart" },
        session: () => fakeSessionOnOrders({ screenshot: breaks }),
    },
    {
        name: "an a11yAudit whose audit",
        step: { type: "a11yAudit", mode: "report" },
        session: () => fakeSessionOnOrders({ audit: breaks }),
    },
    {
        name: "an expectPage whose page read",
        step: {
            type: "expectPage",
            assert: { kind: "title", value: "Orders" },
            criterionId: "cart.title-shown",
        },
        session: () => fakeSessionOnOrders({ page: breaks }),
    },
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

// A session as a tab whose close breaks its promise by rejecting, as a tab's never should.
const asTabThatRejectsWhenClosed = (session: Session): SessionTab => ({
    ...session,
    close: breaks,
});

const tabThatWillNotClose = (changes: Partial<Session> = {}): Session =>
    fakeSessionOnOrders({
        newTab: () =>
            Promise.resolve({
                ok: true,
                value: asTabThatRejectsWhenClosed(fakeSessionOnOrders(changes)),
            }),
    });

const SESSION_CLOSE_FAILED = "session-close-failed";

// The rejection reached the log as a close failure, once, saying why.
function assertReportedAsCloseFailure(events: RunEventSink): void {
    const logged = events.read().filter((event) => event.code === SESSION_CLOSE_FAILED);
    assert.equal(logged.length, 1, JSON.stringify(logged));
    assert.match(logged[0]?.detail ?? "", new RegExp(ADAPTER_BROKE));
}

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

    for (const { name, screenshot } of [
        { name: "cannot read the page", screenshot: cannotRead },
        { name: "throws", screenshot: breaks },
    ]) {
        describe(`given a step inside a frame ${name}`, () => {
            describe("when the run ends", () => {
                test("then it should record the frame step with adapter-error and end Errored", async () => {
                    const frame: JsonRecord = {
                        type: "frame",
                        locator: { by: "testId", testId: "cart-frame" },
                        steps: [{ type: "capture", name: "cart" }],
                    };
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, frame]), {
                        session: fakeSessionOnOrders({ screenshot }),
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
    }

    describe("given a new tab whose check fails", () => {
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

        describe("and the tab rejects as it closes", () => {
            describe("when the run ends", () => {
                test("then it should keep the check's own failure and report the close", async () => {
                    const { result, events } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding(FAILING_CHECK)]),
                        { session: tabThatWillNotClose() },
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
                    assertReportedAsCloseFailure(events);
                });
            });
        });
    });

    describe("given a new tab whose check passes", () => {
        describe("and the tab rejects as it closes", () => {
            describe("when the run ends", () => {
                test("then it should keep the pass and report the close", async () => {
                    const { result, events } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding(PASSING_CHECK)]),
                        { session: tabThatWillNotClose() },
                    );
                    assert.deepEqual(
                        { state: result.state, steps: stepSummaries(result) },
                        {
                            state: "Passed",
                            steps: [
                                ["passed", undefined],
                                ["passed", undefined],
                                ["passed", undefined],
                            ],
                        },
                    );
                    assertReportedAsCloseFailure(events);
                });
            });
        });
    });

    describe("given a new tab whose step throws", () => {
        describe("and the tab rejects as it closes", () => {
            describe("when the run ends", () => {
                test("then it should still have tried the close, keep the throw as adapter-error and report the close", async () => {
                    const tab = fakeSession({ screenshot: breaks, close: breaks });
                    const { result, events } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding({ type: "capture", name: "cart" })]),
                        {
                            session: fakeSession({
                                newTab: () =>
                                    Promise.resolve({
                                        ok: true,
                                        value: asTabThatRejectsWhenClosed(tab),
                                    }),
                            }),
                        },
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
                    assertReportedAsCloseFailure(events);
                });
            });
        });
    });

    describe("given a session whose close rejects", () => {
        describe("when the run ends", () => {
            test("then it should keep the pass and report the close", async () => {
                const { result, events } = await runOnFakeSession(
                    unsafePlan([OPEN_CART, PASSING_CHECK]),
                    { session: fakeSessionOnOrders({ close: breaks }) },
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assertReportedAsCloseFailure(events);
            });
        });
    });

    describe("given a new tab whose step throws", () => {
        describe("and the tab closes", () => {
            describe("when the run ends", () => {
                test("then it should close the tab once, record the tab step with adapter-error and end Errored", async () => {
                    const session = fakeSession({ screenshot: breaks });
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, newTabHolding({ type: "capture", name: "cart" })]),
                        { session },
                    );
                    const [tab] = session.openedTabs();
                    assert.deepEqual(
                        {
                            state: result.state,
                            steps: stepSummaries(result),
                            tabs: session.openedTabs().length,
                            closes: tab?.calls.count("close"),
                        },
                        {
                            state: "Errored",
                            steps: [
                                ["passed", undefined],
                                ["failed", "adapter-error"],
                                ["skipped", undefined],
                            ],
                            tabs: 1,
                            closes: 1,
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
