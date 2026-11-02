// The published JSON Schema describes the plan language for agents and editors. A plan can fit it and
// still be refused for reasons only the project knows, but on the plan's own shape the two must say
// the same thing, or the schema tells a drafter something untrue.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planJsonSchema } from "@revisum/engine";
import { validateAgainstSchema } from "../../../tools/json-schema-validator.ts";
import { navigate, planOf, reference, type JsonRecord } from "./run-value-examples.ts";
import { REMOVE, defaultParser, goldenPlan, goldenPlanNames, withValue } from "./plan-examples.ts";
import { parserEnabling } from "./unsafe-feature-examples.ts";
import { FEATURES } from "./unsafe-feature-steps.ts";

const parsePlan = parserEnabling(FEATURES);
const parseGolden = defaultParser();
const SCHEMA = planJsonSchema();

const fitsSchema = (plan: unknown): boolean => validateAgainstSchema(SCHEMA, plan).length === 0;

const EXPECT_VISIBLE: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "visible" },
    criterionId: "orders.status-shown",
};
const linkCheck = (value: unknown): JsonRecord => ({
    type: "expect",
    locator: { by: "role", role: "link", name: "Fees" },
    assert: { kind: "hrefEquals", value },
    criterionId: "orders.fees-linked",
});
const planNamed = (title: string): JsonRecord =>
    planOf([], { meta: { featureId: "ORDERS-1", specReference: "specs/orders.md#new", title } });
const queryPlan = (query: unknown): JsonRecord =>
    planOf([navigate({ segments: ["orders"], query })]);
const ORDER_CODE = { orderCode: { kind: "uniqueText", prefix: "order" } };

const ACCEPTED_BY_BOTH: readonly { readonly name: string; readonly plan: JsonRecord }[] = [
    { name: "a plan with one check", plan: planOf([]) },
    { name: "a path URL", plan: planOf([navigate("/orders")]) },
    {
        name: "an absolute URL on an allowed origin",
        plan: planOf([navigate("http://127.0.0.1:4173/orders")]),
    },
    {
        name: "a path template",
        plan: planOf(
            [
                navigate({
                    segments: ["orders", reference("orderCode")],
                    query: { tab: reference("orderCode"), page: "1" },
                }),
            ],
            { values: ORDER_CODE },
        ),
    },
    {
        name: "a link check on another origin",
        plan: planOf([linkCheck("https://elsewhere.example/fees")]),
    },
    { name: "a link check on a path", plan: planOf([linkCheck("/fees")]) },
    { name: "a capture", plan: planOf([{ type: "capture", name: "order-summary" }]) },
    { name: "a title with accents", plan: planNamed("Crème brûlée") },
];

const REFUSED_BY_BOTH: readonly { readonly name: string; readonly plan: unknown }[] = [
    { name: "no steps", plan: planOf([], { steps: [] }) },
    { name: "an unknown step", plan: planOf([{ type: "eval", code: "fetch('/admin')" }]) },
    { name: "an unknown top-level field", plan: planOf([], { shell: "rm -rf /" }) },
    { name: "an unknown field on a step", plan: planOf([{ ...EXPECT_VISIBLE, hidden: true }]) },
    {
        name: "a check with no criterion id",
        plan: withValue(planOf([EXPECT_VISIBLE]), ["steps", 0, "criterionId"], REMOVE),
    },
    { name: "an unsupported version", plan: planOf([], { version: "9.9" }) },
    {
        name: "an unknown locator kind",
        plan: planOf([{ ...EXPECT_VISIBLE, locator: { by: "shadow", value: "x" } }]),
    },
    {
        name: "a capture name with spaces",
        plan: planOf([{ type: "capture", name: "order summary" }]),
    },
    { name: "a URL with no leading slash", plan: planOf([navigate("orders")]) },
    { name: "a URL with another scheme", plan: planOf([navigate("ftp://elsewhere.example/x")]) },
    { name: "a title with a control character", plan: planNamed("Pay\u0007now") },
    { name: "a title with a bidirectional override", plan: planNamed("Pay‮now") },
    { name: "a title with a zero width space", plan: planNamed("Pay​now") },
    { name: "a title with a line separator", plan: planNamed("Pay now") },
    { name: "a query key with a space", plan: queryPlan({ "a b": "x" }) },
];

// The language may go either way on these, but both must go the same way.
const THE_TWO_AGREE_ON: readonly { readonly name: string; readonly plan: unknown }[] = [
    {
        name: "a URL with an upper-case scheme",
        plan: planOf([navigate("HTTP://127.0.0.1:4173/orders")]),
    },
    {
        name: "a URL with a leading space",
        plan: planOf([navigate(" http://127.0.0.1:4173/orders")]),
    },
    { name: "a path with a leading space", plan: planOf([navigate(" /orders")]) },
    {
        name: "a link check with an upper-case scheme",
        plan: planOf([linkCheck("HTTP://elsewhere.example/fees")]),
    },
    {
        name: "a link check with a leading space",
        plan: planOf([linkCheck(" https://elsewhere.example/fees")]),
    },
    { name: "a link check on a path with a leading space", plan: planOf([linkCheck(" /fees")]) },
    { name: "a query with a __proto__ key", plan: queryPlan(JSON.parse('{"__proto__":"x"}')) },
];

describe("Using the published plan schema", () => {
    for (const name of goldenPlanNames()) {
        describe(`given the golden plan ${name}`, () => {
            describe("when both judge it", () => {
                test("then it should fit the schema and pass the parser", () => {
                    const plan = goldenPlan(name);
                    const parsed = parseGolden(plan);
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.deepEqual(validateAgainstSchema(SCHEMA, plan), []);
                });
            });
        });
    }

    for (const { name, plan } of ACCEPTED_BY_BOTH) {
        describe(`given ${name}`, () => {
            describe("when both judge it", () => {
                test("then it should fit the schema and pass the parser", () => {
                    const parsed = parsePlan(plan);
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.deepEqual(validateAgainstSchema(SCHEMA, plan), []);
                });
            });
        });
    }

    for (const { name, plan } of REFUSED_BY_BOTH) {
        describe(`given ${name}`, () => {
            describe("when both judge it", () => {
                test("then it should break the schema and fail the parser", () => {
                    assert.deepEqual(
                        { parser: parsePlan(plan).ok, schema: fitsSchema(plan) },
                        { parser: false, schema: false },
                    );
                });
            });
        });
    }

    for (const { name, plan } of THE_TWO_AGREE_ON) {
        describe(`given ${name}`, () => {
            describe("when both judge it", () => {
                test("then it should get one answer from both", () => {
                    assert.equal(fitsSchema(plan), parsePlan(plan).ok);
                });
            });
        });
    }
});
