// No driver's probe reports a checked or focused state, so these checks can't be decided on their
// merits. The run says so with unsupported-step and doesn't wait: it never reads the page for them,
// even on a driver that declares every optional feature.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DRIVER_FEATURES } from "@revisum/engine";
import { OPEN_ORDERS, label, planOf, runPlan, type JsonRecord } from "./run-value-examples.ts";

const CONSENT = label("I agree to the terms");
const checkOf = (kind: string): JsonRecord => ({
    type: "expect",
    locator: CONSENT,
    assert: { kind },
    criterionId: "consent.terms-accepted",
});

describe("Using the run", () => {
    for (const kind of ["checked", "unchecked", "focused"]) {
        describe(`given a plan with a "${kind}" check`, () => {
            describe("and a driver that declares every optional feature", () => {
                describe("when the run reaches the check", () => {
                    test("then it should fail with unsupported-step without reading the page", async () => {
                        const { result, recording } = await runPlan(
                            planOf([OPEN_ORDERS, checkOf(kind)]),
                            {
                                performs: DRIVER_FEATURES,
                            },
                        );
                        assert.equal(result.state, "Failed");
                        assert.deepEqual(
                            result.steps.map((step) => [step.outcome, step.code]),
                            [
                                ["passed", undefined],
                                ["failed", "unsupported-step"],
                                ["skipped", undefined],
                            ],
                        );
                        assert.equal(recording.probes, 0, "the check read the page");
                    });
                });
            });
        });
    }

    describe("given a plan with a check a driver can decide", () => {
        describe("when the run reaches the check", () => {
            test("then it should read the page and pass", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, checkOf("visible")]),
                    {
                        performs: DRIVER_FEATURES,
                    },
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.ok(recording.probes > 0);
            });
        });
    });
});
