// A project's call bodies and vendor extensions are recorded and hashed as JSON, and nothing stricter
// reads them afterwards. So a Date, a Map or a class instance is refused where it sits, rather than
// read as an object with no fields, even when its own fields would be fine in JSON.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProject } from "@revisum/engine";
import { classInstanceHolding } from "../../../support/ClassInstanceHolding.ts";
import { testProjectInput, withValue, type JsonRecord } from "../plan/examples/GoldenPlan.ts";
import { callProjectFile, declarationOf, projectRefusal } from "../run/executors/service-calls/examples/ShopService.ts";

const NOT_JSON_VALUES: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: "a Date", value: new Date(0) },
    { name: "a Map", value: new Map([["customer", "Ada"]]) },
    { name: "a class instance holding plain fields", value: classInstanceHolding({ note: "hi" }) },
];

const BODY = ["calls", "createOrder", "body"];
const EXTENSION_KEY = "acme:device-farm-pool";
const EXTENSION_PATH = `$.matrix[0].vendorExtensions.${EXTENSION_KEY}`;

const projectWithExtension = (value: unknown): JsonRecord =>
    withValue(testProjectInput(), ["matrix", 0, "vendorExtensions"], { [EXTENSION_KEY]: value });

describe("Using the project parser", () => {
    for (const { name, value } of NOT_JSON_VALUES) {
        describe(`given ${name} as a call's body`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse the body as wrong_type", () => {
                    const project = withValue(callProjectFile(), BODY, value);
                    assert.deepEqual(projectRefusal(project), [
                        "wrong_type $.calls.createOrder.body",
                    ]);
                });
            });
        });

        describe(`given ${name} inside a call's body`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse that value as wrong_type", () => {
                    const project = withValue(callProjectFile(), BODY, { customer: value });
                    assert.deepEqual(projectRefusal(project), [
                        "wrong_type $.calls.createOrder.body.customer",
                    ]);
                });
            });
        });

        describe(`given ${name} as a vendor extension's value`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse the extension as wrong_type", () => {
                    assert.deepEqual(projectRefusal(projectWithExtension(value)), [
                        `wrong_type ${EXTENSION_PATH}`,
                    ]);
                });
            });
        });

        describe(`given ${name} nested in a vendor extension's value`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse the extension as wrong_type", () => {
                    const extension = { pools: [{ since: value }] };
                    assert.deepEqual(projectRefusal(projectWithExtension(extension)), [
                        `wrong_type ${EXTENSION_PATH}`,
                    ]);
                });
            });
        });
    }

    describe("given a call's body as JSON writes it", () => {
        describe("when the project is parsed", () => {
            test("then it should keep the body", () => {
                const body = { note: "hi", lines: [{ quantity: 1 }] };
                const parsed = parseProject(withValue(callProjectFile(), BODY, body));
                assert.ok(parsed.ok, JSON.stringify(parsed));
                assert.deepEqual(declarationOf(parsed.value, "createOrder").body, body);
            });
        });
    });

    describe("given a vendor extension as JSON writes it", () => {
        describe("when the project is parsed", () => {
            test("then it should keep the value", () => {
                const extension = { pools: [{ since: "2026-01-01" }] };
                const parsed = parseProject(projectWithExtension(extension));
                assert.ok(parsed.ok, JSON.stringify(parsed));
                assert.deepEqual(parsed.value.matrix[0]?.vendorExtensions, {
                    [EXTENSION_KEY]: extension,
                });
            });
        });
    });
});
