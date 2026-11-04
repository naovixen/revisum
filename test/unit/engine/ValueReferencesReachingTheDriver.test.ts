// A driver refuses any step that still holds a value reference, so the engine has to replace every
// one before it acts. Each plan here uses a generated value in one place a step can hold it, and runs
// on a session that refuses as a real driver does.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DRIVER_FEATURES } from "@revisum/engine";
import {
    OPEN_ORDERS,
    label,
    planOf,
    reference,
    runPlan,
    type JsonRecord,
} from "./run-value-examples.ts";

const VALUE_NAME = "orderCode";
const VALUE = reference(VALUE_NAME);
const VALUES: JsonRecord = { [VALUE_NAME]: { kind: "uniqueText", prefix: "order" } };
const FIELD = label("Search");

const STEPS_HOLDING_A_VALUE: readonly (readonly [string, JsonRecord])[] = [
    ["a fill's value", { type: "fill", locator: FIELD, value: VALUE }],
    ["a fill's lines", { type: "fill", locator: FIELD, value: { lines: ["Order", VALUE] } }],
    ["a select's option", { type: "select", locator: FIELD, option: VALUE }],
    [
        "a click on a named role",
        { type: "click", locator: { by: "role", role: "link", name: VALUE } },
    ],
    ["a click on a label", { type: "click", locator: label(VALUE) }],
    ["a click on a text", { type: "click", locator: { by: "text", text: VALUE } }],
    ["a hover on a label", { type: "hover", locator: label(VALUE) }],
    ["a key press on a label", { type: "press", locator: label(VALUE), key: "Enter" }],
];

describe("Using a run", () => {
    describe("given a plan with a generated value", () => {
        for (const [where, step] of STEPS_HOLDING_A_VALUE) {
            describe(`when it is used in ${where}`, () => {
                test("then it should hand the driver a step holding only text, and pass", async () => {
                    const { result, recording } = await runPlan(
                        planOf([OPEN_ORDERS, step], { values: VALUES }),
                        { performs: DRIVER_FEATURES },
                    );
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    const [acted] = recording.actions;
                    assert.equal(acted?.type, step["type"]);
                    assert.equal(JSON.stringify(acted).includes("valueName"), false);
                });
            });
        }
    });
});
