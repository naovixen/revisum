// A driver's ports promise a Result. One that throws instead breaks that promise, but the run must still
// end with a stated outcome, so a run's result always exists and says why it could not test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeSessionOnOrders, runOnFakeSession, stepSummaries } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";

const DRIVER_BROKE = "the driver broke";
const breaks = (): never => {
    throw new Error(DRIVER_BROKE);
};
const rejects = (): Promise<never> => Promise.reject(new Error(DRIVER_BROKE));

const BROKEN_MEMBERS = [
    { name: "supports throws", driver: { supports: breaks } },
    { name: "open throws", driver: { open: breaks } },
    { name: "open rejects", driver: { open: rejects } },
    { name: "build check throws", driver: { build: breaks } },
    { name: "build check rejects", driver: { build: rejects } },
];

describe("Using the run", () => {
    for (const { name, driver } of BROKEN_MEMBERS) {
        describe(`given a driver whose ${name}`, () => {
            describe("when a plan is run", () => {
                test("then it should end Errored instead of rejecting, with nothing run", async () => {
                    const session = fakeSessionOnOrders();
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        session,
                        driver,
                    });
                    assert.equal(result.state, "Errored", JSON.stringify(result));
                    assert.equal(JSON.stringify(result).includes(DRIVER_BROKE), false);
                    assert.deepEqual(stepSummaries(result).length <= 1, true);
                });
            });
        });
    }

    describe("given a driver that keeps its promises", () => {
        describe("when a plan is run", () => {
            test("then it should pass", async () => {
                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]));
                assert.equal(result.state, "Passed", JSON.stringify(result));
            });
        });
    });
});
