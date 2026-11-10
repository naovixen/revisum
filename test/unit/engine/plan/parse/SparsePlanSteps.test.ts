// A plan's steps are read one by one, and a list with holes must not pass because nothing was read
// where a step is missing: the hole would then reach the run as a step that is not there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    CLOSING_CHECK,
    accepted,
    navigate,
    parserFor,
    planOf,
    type JsonRecord,
} from "../../run/values/examples/RunPlan.ts";

const parsePlan = parserFor();

const stepsWithAHole = (first: unknown, last: unknown): readonly unknown[] => {
    const steps: unknown[] = [first];
    steps[2] = last;
    return steps;
};

const planWithHoleInSteps = (): JsonRecord =>
    planOf([], { steps: stepsWithAHole(navigate("/orders"), CLOSING_CHECK) });

const planWithHoleInFrame = (): JsonRecord =>
    planOf([
        {
            type: "frame",
            locator: { by: "testId", testId: "panel" },
            steps: stepsWithAHole({ type: "capture", name: "first" }, CLOSING_CHECK),
        },
    ]);

describe("Using the plan parser", () => {
    describe("given a plan whose list of steps has a hole", () => {
        describe("when the plan is parsed", () => {
            test("then it should refuse the plan", () => {
                assert.equal(parsePlan(planWithHoleInSteps()).ok, false);
            });
        });
    });

    describe("given a frame whose list of steps has a hole", () => {
        describe("when the plan is parsed", () => {
            test("then it should refuse the plan", () => {
                assert.equal(parsePlan(planWithHoleInFrame()).ok, false);
            });
        });
    });

    describe("given a plan whose list of steps has no hole", () => {
        describe("when the plan is parsed", () => {
            test("then it should keep every step", () => {
                const plan = planOf([], { steps: [navigate("/orders"), CLOSING_CHECK] });
                assert.equal(accepted(parsePlan, plan).steps.length, 2);
            });
        });
    });
});
