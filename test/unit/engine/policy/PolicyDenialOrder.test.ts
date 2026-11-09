// The gate reports the first denial it finds, in a fixed order: every step's own rule, frames and
// second tabs included, before any rule on what the plan calls; and among calls, the plan's own steps
// before its cleanup. A barred step is therefore reported over a barred call that comes before it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    DESTRUCTIVE_PATH,
    OPEN_ACCOUNT_PAGE,
    POLICY,
    PRODUCTION_ORIGIN,
    comparable,
    decideOn,
    deniedCodes,
    navigate,
    parsedPlan,
    planOf,
    policyProjectInput,
    testGate,
    type JsonRecord,
} from "./examples/Policy.ts";

const SERVICES = [
    { name: "shop", origin: "http://127.0.0.1:4180", private: true },
    { name: "live", origin: PRODUCTION_ORIGIN, private: false },
];
const CALLS: JsonRecord = {
    // A write the declaration does not allow in proposals.
    createOrder: {
        service: "shop",
        method: "POST",
        path: "/api/orders",
        parameters: {},
        effect: "write",
        successStatuses: [201],
    },
    // A read of the live shop, on the project's production origin.
    liveOrderCount: {
        service: "live",
        method: "GET",
        path: "/api/orders/count",
        parameters: {},
        effect: "read",
        successStatuses: [200],
        fields: { count: "/count" },
    },
};
const PROJECT_INPUT = policyProjectInput({ services: SERVICES, calls: CALLS, policy: POLICY });

const WRITE_IN_PROPOSAL: JsonRecord = { type: "call", call: "createOrder", arguments: {} };
const PRODUCTION_CALL: JsonRecord = { type: "call", call: "liveOrderCount", arguments: {} };
const DESTRUCTIVE_NAVIGATION = navigate(DESTRUCTIVE_PATH);

const planWith = (steps: readonly unknown[], cleanup: readonly unknown[] = []): JsonRecord => ({
    ...planOf(steps),
    version: "1.3",
    ...(cleanup.length === 0 ? {} : { cleanup }),
});

async function decideProposal(raw: JsonRecord) {
    const tested = await testGate(PROJECT_INPUT);
    const decision = comparable(decideOn(tested, parsedPlan(raw, PROJECT_INPUT)));
    return { decision, denials: deniedCodes(tested.events) };
}

describe("Using the policy gate", () => {
    describe("given a proposal with a barred call", () => {
        describe("and a barred step after it", () => {
            describe("when the gate decides", () => {
                test("then it should report the barred step alone", async () => {
                    const { decision, denials } = await decideProposal(
                        planWith([OPEN_ACCOUNT_PAGE, WRITE_IN_PROPOSAL, DESTRUCTIVE_NAVIGATION]),
                    );
                    assert.deepEqual(
                        { decision, denials },
                        {
                            decision: {
                                kind: "deny",
                                rule: "destructive-navigation",
                                stepIndex: 2,
                            },
                            denials: ["destructive-navigation"],
                        },
                    );
                });
            });
        });

        describe("and a barred step inside a second tab after it", () => {
            describe("when the gate decides", () => {
                test("then it should report the second tab's step", async () => {
                    const tab = {
                        type: "newTab",
                        url: "/account",
                        steps: [DESTRUCTIVE_NAVIGATION],
                    };
                    const { decision } = await decideProposal(
                        planWith([OPEN_ACCOUNT_PAGE, WRITE_IN_PROPOSAL, tab]),
                    );
                    assert.deepEqual(decision, {
                        kind: "deny",
                        rule: "destructive-navigation",
                        stepIndex: 2,
                    });
                });
            });
        });

        describe("and no barred step", () => {
            describe("when the gate decides", () => {
                test("then it should report the barred call", async () => {
                    const { decision, denials } = await decideProposal(
                        planWith([
                            OPEN_ACCOUNT_PAGE,
                            WRITE_IN_PROPOSAL,
                            navigate("/account/settings"),
                        ]),
                    );
                    assert.deepEqual(
                        { decision, denials },
                        {
                            decision: {
                                kind: "deny",
                                rule: "side-effect-in-proposal",
                                stepIndex: 1,
                            },
                            denials: ["side-effect-in-proposal"],
                        },
                    );
                });
            });
        });
    });

    describe("given a proposal with a barred call in its cleanup", () => {
        describe("and a barred step", () => {
            describe("when the gate decides", () => {
                test("then it should report the barred step", async () => {
                    const { decision } = await decideProposal(
                        planWith([OPEN_ACCOUNT_PAGE, DESTRUCTIVE_NAVIGATION], [WRITE_IN_PROPOSAL]),
                    );
                    assert.deepEqual(decision, {
                        kind: "deny",
                        rule: "destructive-navigation",
                        stepIndex: 1,
                    });
                });
            });
        });

        describe("and another barred call in its steps", () => {
            describe("when the gate decides", () => {
                test("then it should report the call in its steps", async () => {
                    const { decision } = await decideProposal(
                        planWith([OPEN_ACCOUNT_PAGE, PRODUCTION_CALL], [WRITE_IN_PROPOSAL]),
                    );
                    assert.deepEqual(decision, {
                        kind: "deny",
                        rule: "production-origin",
                        stepIndex: 1,
                    });
                });
            });
        });
    });
});
