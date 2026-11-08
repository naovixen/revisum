// What a plan says about its own unsafe features, for a step of every type: exactly those the step
// writes, and none for a closed step. Moving where a step type says so must not change any of them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { unsafeFeaturesOf } from "@revisum/engine";
import {
    DECLARED_FIXTURE,
    EVERY_STEP_TYPE_EXAMPLES,
    type StepExample,
} from "./EveryStepTypeExamples.ts";
import { acceptedBy, parserEnabling } from "./unsafe-feature-examples.ts";
import { FEATURES, unsafePlan } from "./unsafe-feature-steps.ts";

const parsePlan = parserEnabling(FEATURES, { fixtures: [DECLARED_FIXTURE] });

const featuresOfPlanHolding = ({ step, before = [] }: StepExample): readonly string[] =>
    unsafeFeaturesOf(acceptedBy(parsePlan, unsafePlan([...before, step])));

describe("Using unsafeFeaturesOf", () => {
    for (const [type, examples] of Object.entries(EVERY_STEP_TYPE_EXAMPLES)) {
        for (const example of examples as readonly StepExample[]) {
            const expected = (example.unsafeFeatures ?? []).toSorted();

            describe(`given a plan holding a ${type} step ${example.name}`, () => {
                describe("when its unsafe features are listed", () => {
                    test(`then it should list ${expected.length === 0 ? "none" : expected.join(" and ")}`, () => {
                        assert.deepEqual(featuresOfPlanHolding(example), expected);
                    });
                });
            });
        }
    }
});
