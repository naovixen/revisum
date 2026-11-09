// A literal fill aimed at a sensitive field is a secret written into the plan. A css locator can
// name the field through the locator it is evaluated inside, which says just as plainly that the
// text is a password.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    acceptedBy,
    parserEnabling,
    rejection,
} from "../../plan/unsafe-features/examples/LostByFeature.ts";
import {
    OPEN_CART,
    css,
    unsafePlan,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const parsePlan = parserEnabling(["css-locator"]);

const fillInside = (inside: JsonRecord, value = "horse battery staple"): JsonRecord =>
    unsafePlan([OPEN_CART, { type: "fill", locator: css("input", { inside }), value }]);

const SENSITIVE_PARENTS: readonly { readonly name: string; readonly inside: JsonRecord }[] = [
    { name: "a label Password", inside: { by: "label", label: "Password" } },
    { name: "a region named API key", inside: { by: "role", role: "region", name: "API key" } },
    { name: "a test id authToken", inside: { by: "testId", testId: "authToken" } },
    { name: "a css selector #client_secret", inside: css("#client_secret") },
    {
        name: "a css locator inside a label Password",
        inside: css("div", { inside: { by: "label", label: "Password" } }),
    },
];

const ORDINARY_PARENTS: readonly { readonly name: string; readonly inside: JsonRecord }[] = [
    { name: "a label Shipping address", inside: { by: "label", label: "Shipping address" } },
    { name: "a css locator inside a form", inside: css("div", { inside: css("form.address") }) },
];

describe("Using the plan parser", () => {
    for (const { name, inside } of SENSITIVE_PARENTS) {
        describe(`given a literal fill of a field inside ${name}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the value as literal_secret", () => {
                    assert.deepEqual(rejection(parsePlan, fillInside(inside)), [
                        "literal_secret $.steps[1].value",
                    ]);
                });
            });
        });

        describe(`given an empty fill of a field inside ${name}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should accept the plan, because it writes no secret", () => {
                    assert.equal(acceptedBy(parsePlan, fillInside(inside, "")).steps.length, 3);
                });
            });
        });
    }

    for (const { name, inside } of ORDINARY_PARENTS) {
        describe(`given a literal fill of a field inside ${name}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should accept the plan", () => {
                    assert.equal(acceptedBy(parsePlan, fillInside(inside)).steps.length, 3);
                });
            });
        });
    }
});
