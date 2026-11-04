// A step's remembered fields have nothing stricter behind them, so only what JSON writes is read. A
// value with several written forms is different: telling the forms apart looks at any object, so that
// the form's own decoder has the last word and reports not_object, not a plain wrong_type.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classInstanceHolding } from "../../support/ClassInstanceHolding.ts";
import { defaultParser, signupPlan, withValue, type JsonRecord } from "./plan-examples.ts";
import {
    call,
    callParser,
    callPlanOf,
    CREATE_ORDER,
    orderArguments,
} from "./service-call-examples.ts";

const FILL_VALUE = ["steps", 3, "value"];
const FILL_VALUE_PATH = "$.steps[3].value";
const NAVIGATE_URL = ["steps", 0, "url"];
const NAVIGATE_URL_PATH = "$.steps[0].url";

const errorsOf = (parsed: ReturnType<ReturnType<typeof callParser>>): readonly string[] =>
    parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`);

const planRemembering = (remember: unknown): JsonRecord =>
    callPlanOf([call("createOrder", orderArguments(), remember)]);

const errorsParsing = (plan: JsonRecord): readonly string[] => errorsOf(defaultParser()(plan));

describe("Using the plan parser", () => {
    for (const { name, value } of [
        { name: "a Date", value: new Date(0) },
        { name: "a Map", value: new Map([["orderId", "orderId"]]) },
        {
            name: "a class instance holding a declared field",
            value: classInstanceHolding({ orderId: "orderId" }),
        },
    ]) {
        describe(`given ${name} as a call step's remember`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse it as wrong_type at the remember", () => {
                    assert.deepEqual(errorsOf(callParser()(planRemembering(value))), [
                        "wrong_type $.steps[0].remember",
                    ]);
                });
            });
        });
    }

    describe("given a call step's remember as JSON writes it", () => {
        describe("when the plan is parsed", () => {
            test("then it should accept it", () => {
                assert.deepEqual(errorsOf(callParser()(callPlanOf([CREATE_ORDER]))), []);
            });
        });
    });

    for (const { name, value } of [
        { name: "literal text", value: "Ada Lovelace" },
        { name: "lines of text", value: { lines: ["Ada", "Lovelace"] } },
        { name: "a declared secret", value: { secretName: "SHOP_API_TOKEN" } },
    ]) {
        describe(`given a fill value written as ${name}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should accept it", () => {
                    assert.deepEqual(errorsParsing(withValue(signupPlan(), FILL_VALUE, value)), []);
                });
            });
        });
    }

    for (const { name, value } of [
        { name: "a Date", value: new Date(0) },
        {
            name: "a class instance holding a declared secret",
            value: classInstanceHolding({ secretName: "SHOP_API_TOKEN" }),
        },
    ]) {
        describe(`given ${name} as a fill value`, () => {
            describe("when the plan is parsed", () => {
                test("then it should leave the refusal to the form's decoder, as not_object", () => {
                    assert.deepEqual(errorsParsing(withValue(signupPlan(), FILL_VALUE, value)), [
                        `not_object ${FILL_VALUE_PATH}`,
                    ]);
                });
            });
        });

        describe(`given ${name} as a navigate step's url`, () => {
            describe("when the plan is parsed", () => {
                test("then it should leave the refusal to the form's decoder, as not_object", () => {
                    assert.deepEqual(errorsParsing(withValue(signupPlan(), NAVIGATE_URL, value)), [
                        `not_object ${NAVIGATE_URL_PATH}`,
                    ]);
                });
            });
        });
    }

    describe("given a navigate step's url written as a path template", () => {
        describe("when the plan is parsed", () => {
            test("then it should accept it", () => {
                const plan = withValue(signupPlan(), NAVIGATE_URL, { segments: ["signup"] });
                assert.deepEqual(errorsParsing(plan), []);
            });
        });
    });
});
