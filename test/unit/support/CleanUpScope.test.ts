import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCleanUpScope } from "../../support/CleanUpScope.ts";

describe("Using the clean-up scope", () => {
    describe("given clean-ups registered in order", () => {
        describe("when it runs them all", () => {
            test("then it should run the last registered first", async () => {
                const scope = createCleanUpScope();
                const order: string[] = [];
                scope.add(() => {
                    order.push("first");
                });
                scope.add(() => {
                    order.push("second");
                });
                await scope.runAll();
                assert.deepEqual(order, ["second", "first"]);
            });

            test("then it should wait for an asynchronous clean-up before the next", async () => {
                const scope = createCleanUpScope();
                const order: string[] = [];
                scope.add(() => {
                    order.push("first");
                });
                scope.add(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    order.push("second");
                });
                await scope.runAll();
                assert.deepEqual(order, ["second", "first"]);
            });
        });

        describe("when it runs them all twice", () => {
            test("then it should run each clean-up once", async () => {
                const scope = createCleanUpScope();
                let runs = 0;
                scope.add(() => {
                    runs += 1;
                });
                await scope.runAll();
                await scope.runAll();
                assert.equal(runs, 1);
            });
        });
    });

    describe("given clean-ups that fail", () => {
        describe("when it runs them all", () => {
            test("then it should run every one and report each failure", async () => {
                const scope = createCleanUpScope();
                const order: string[] = [];
                const lateFailure = new Error("late failure");
                const earlyFailure = new Error("early failure");
                scope.add(() => {
                    order.push("first");
                    throw earlyFailure;
                });
                scope.add(() => {
                    order.push("second");
                });
                scope.add(() => {
                    order.push("third");
                    return Promise.reject(lateFailure);
                });
                await assert.rejects(scope.runAll(), (error: unknown) => {
                    assert.ok(error instanceof AggregateError, "an aggregate error");
                    assert.deepEqual(error.errors, [lateFailure, earlyFailure]);
                    return true;
                });
                assert.deepEqual(order, ["third", "second", "first"]);
            });
        });
    });

    describe("given no clean-ups", () => {
        describe("when it runs them all", () => {
            test("then it should finish without error", async () => {
                await createCleanUpScope().runAll();
            });
        });
    });
});
