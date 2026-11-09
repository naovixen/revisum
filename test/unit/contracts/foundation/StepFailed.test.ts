// A failed step's result is hashed as written, so the failure's fields and their order are part of
// what every result says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StepCode, StepOutcome, stepFailed, type StepFailure } from "@revisum/contracts";

describe("Using stepFailed", () => {
    describe("given a step code", () => {
        describe("when the failure is built", () => {
            test("then it should hold only the failed outcome and the code", () => {
                assert.deepEqual(stepFailed(StepCode.ValueEmpty), {
                    outcome: StepOutcome.Failed,
                    code: "value-empty",
                });
            });

            test("then it should write the outcome before the code", () => {
                assert.equal(
                    JSON.stringify(stepFailed(StepCode.ValueEmpty)),
                    '{"outcome":"failed","code":"value-empty"}',
                );
            });

            test("then it should keep the code's own type", () => {
                const failure = stepFailed(StepCode.ValueEmpty);
                // @ts-expect-error The failure holds this code and no other.
                const otherCode: StepFailure<typeof StepCode.ValueUnsafe> = failure;
                assert.equal(otherCode.code, "value-empty");
            });
        });

        describe("and a result it is spread into", () => {
            describe("when a record is added after it", () => {
                test("then it should write the base, the failure and the record, in that order", () => {
                    const result = {
                        index: 2,
                        ...stepFailed(StepCode.ValueEmpty),
                        observed: "absent",
                    };
                    assert.equal(
                        JSON.stringify(result),
                        '{"index":2,"outcome":"failed","code":"value-empty","observed":"absent"}',
                    );
                });
            });
        });
    });

    describe("given text that is not one of the codes", () => {
        describe("when the failure is built", () => {
            test("then it should not compile", () => {
                // @ts-expect-error A step's code is a closed set.
                const failure = stepFailed("anything-at-all");
                assert.equal(failure.code, "anything-at-all");
            });
        });
    });
});
