// The runtime guard judges what the static check can't: where a navigation goes once its values are
// known, and the element a fill, hover, select or upload resolved to.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { GuardVerdict, ResolvedElement } from "@revisum/engine";
import { DECLARED_FIXTURE } from "../plan/examples/EveryStepTypeExamples.ts";
import {
    ALLOWED,
    ALLOWED_UNNAMED_TEST_ID,
    CLOSING_CHECK,
    ENGLISH,
    NO_ELEMENT,
    OPEN_ACCOUNT_PAGE,
    ORIGIN,
    PRODUCTION_ORIGIN,
    UNLISTED_ORIGIN,
    denied,
    element,
    label,
    localeOf,
    navigate,
    parsedPlan,
    planOf,
    policyProjectInput,
    stepAt,
    testGate,
    testId,
    type JsonRecord,
    type TestGate,
} from "./examples/Policy.ts";

// The project a plan is parsed against may name more origins than the trusted one, so a plan that
// parsed can still name an origin the guard must refuse.
const PARSING_PROJECT: JsonRecord = policyProjectInput({
    origins: [ORIGIN, PRODUCTION_ORIGIN, UNLISTED_ORIGIN],
    fixtures: [DECLARED_FIXTURE],
});

const NAMED_FIELD = label("Display name");
const ELEMENT_ACTIONS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a hover", step: { type: "hover", locator: NAMED_FIELD } },
    { name: "a fill", step: { type: "fill", locator: NAMED_FIELD, value: "Ada" } },
    { name: "a select", step: { type: "select", locator: NAMED_FIELD, option: "Ada" } },
    {
        name: "an upload",
        step: { type: "upload", locator: NAMED_FIELD, fixture: DECLARED_FIXTURE },
    },
];

let tested: TestGate;
before(async () => {
    tested = await testGate();
});

function verdictOn(steps: readonly JsonRecord[], resolved: ResolvedElement): GuardVerdict {
    const plan = parsedPlan(planOf(steps), PARSING_PROJECT);
    return tested.gate.guardAction(
        stepAt(plan, steps.length - 1),
        steps.length - 1,
        resolved,
        null,
        localeOf(tested.project, ENGLISH),
    );
}

describe("Using the policy gate's runtime guard", () => {
    describe("given a navigation to an origin the trusted project does not declare", () => {
        describe("when the guard is asked", () => {
            test("then it should deny it as undeclared-origin", () => {
                assert.deepEqual(
                    verdictOn([navigate(`${UNLISTED_ORIGIN}/account`)], NO_ELEMENT),
                    denied("undeclared-origin", 0),
                );
            });
        });
    });

    describe("given a second tab opening an origin the trusted project does not declare", () => {
        describe("when the guard is asked", () => {
            test("then it should deny it as undeclared-origin", () => {
                const opening = {
                    type: "newTab",
                    url: `${UNLISTED_ORIGIN}/account`,
                    steps: [CLOSING_CHECK],
                };

                assert.deepEqual(verdictOn([opening], NO_ELEMENT), denied("undeclared-origin", 0));
            });
        });
    });

    describe("given a navigation to an origin the trusted project declares", () => {
        describe("when the guard is asked", () => {
            test("then it should allow it", () => {
                assert.deepEqual(verdictOn([navigate(`${ORIGIN}/account`)], NO_ELEMENT), ALLOWED);
            });
        });
    });

    for (const { name, step } of ELEMENT_ACTIONS) {
        describe(`given ${name} on a control with no accessible name`, () => {
            describe("when the guard is asked", () => {
                test("then it should deny it as unnamed-control", () => {
                    assert.deepEqual(
                        verdictOn(
                            [OPEN_ACCOUNT_PAGE, step],
                            element({ role: "textbox", name: null }),
                        ),
                        denied("unnamed-control", 1),
                    );
                });
            });
        });

        describe(`given ${name} on a control with a name`, () => {
            describe("when the guard is asked", () => {
                test("then it should allow it", () => {
                    assert.deepEqual(
                        verdictOn(
                            [OPEN_ACCOUNT_PAGE, step],
                            element({ role: "textbox", name: "Display name" }),
                        ),
                        ALLOWED,
                    );
                });
            });
        });
    }

    describe("given a fill on an unnamed control", () => {
        describe("and the project allows that control by its test id", () => {
            describe("when the guard is asked", () => {
                test("then it should allow it", () => {
                    const fill = {
                        type: "fill",
                        locator: testId(ALLOWED_UNNAMED_TEST_ID),
                        value: "Ada",
                    };

                    assert.deepEqual(
                        verdictOn(
                            [OPEN_ACCOUNT_PAGE, fill],
                            element({ role: "textbox", name: null }),
                        ),
                        ALLOWED,
                    );
                });
            });
        });
    });
});
