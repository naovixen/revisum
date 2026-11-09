// A readable plan's maps are read into plain JSON. A map that assigned "__proto__" as a key would
// set its prototype and lose the key without a word, while the JSON form holds it as a key: one
// plan with two meanings. Whatever the language decides about the key, both forms must decide it
// alike.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planHash, readPlanText, writePlanText } from "@revisum/engine";
import { accepted, navigate, reference, type JsonRecord } from "../../run/values/examples/RunPlan.ts";
import { unsafeLimits } from "./examples/UnsafeMark.ts";
import { parserEnabling } from "../unsafe-features/examples/LostByFeature.ts";
import {
    FEATURES,
    INLINE_SOURCE,
    OPEN_CART,
    READ_CART,
    unsafePlan,
} from "../unsafe-features/examples/UnsafePlan.ts";

const parsePlan = parserEnabling(FEATURES);
const limits = unsafeLimits();

const ORDER_CODE_VALUES: JsonRecord = {
    values: { orderCode: { kind: "uniqueText", prefix: "order" } },
};

const queryPlan = (query: unknown): JsonRecord =>
    unsafePlan([navigate({ segments: ["orders"], query })], ORDER_CODE_VALUES);
const argumentsPlan = (scriptArguments: unknown): JsonRecord =>
    unsafePlan([OPEN_CART, { ...READ_CART, arguments: scriptArguments }]);
const rememberPlan = (remember: unknown): JsonRecord =>
    unsafePlan([OPEN_CART, { ...READ_CART, remember }]);
const fieldsPlan = (fields: unknown): JsonRecord =>
    unsafePlan([
        OPEN_CART,
        {
            type: "evaluate",
            script: { inline: { source: INLINE_SOURCE, effect: "read", fields } },
            arguments: {},
        },
    ]);

// JSON.parse makes "__proto__" an own key, as a plan file on disk would.
const PROTOTYPE_KEY_CASES: readonly {
    readonly name: string;
    readonly withoutKey: JsonRecord;
    readonly writtenText: string;
    readonly textWithKey: string;
    readonly jsonWithKey: JsonRecord;
}[] = [
    {
        name: "a query with a text value",
        withoutKey: queryPlan({ tab: "items" }),
        writtenText: 'with query tab "items"',
        textWithKey: 'with query tab "items", __proto__ "x"',
        jsonWithKey: queryPlan(JSON.parse('{"tab":"items","__proto__":"x"}')),
    },
    {
        name: "a query with a value reference",
        withoutKey: queryPlan({ tab: "items" }),
        writtenText: 'with query tab "items"',
        textWithKey: 'with query tab "items", __proto__ {orderCode}',
        jsonWithKey: queryPlan(JSON.parse('{"tab":"items","__proto__":{"valueName":"orderCode"}}')),
    },
    {
        name: "a script's arguments",
        withoutKey: argumentsPlan({ currency: "eur" }),
        writtenText: 'with currency "eur"',
        textWithKey: 'with currency "eur", __proto__ "x"',
        jsonWithKey: argumentsPlan(JSON.parse('{"currency":"eur","__proto__":"x"}')),
    },
    {
        name: "a step's remembered fields",
        withoutKey: rememberPlan({ cartCount: "itemCount" }),
        writtenText: "remembering field itemCount as cartCount",
        textWithKey: "remembering field itemCount as cartCount, field total as __proto__",
        jsonWithKey: rememberPlan(JSON.parse('{"cartCount":"itemCount","__proto__":"total"}')),
    },
    {
        name: "an inline script's fields",
        withoutKey: fieldsPlan({ blockCount: "/blocks" }),
        writtenText: 'returning blockCount at "/blocks"',
        textWithKey: 'returning blockCount at "/blocks", __proto__ at "/x"',
        jsonWithKey: fieldsPlan(JSON.parse('{"blockCount":"/blocks","__proto__":"/x"}')),
    },
];

const textOf = (plan: JsonRecord): string => writePlanText(accepted(parsePlan, plan));

const changedText = (plan: JsonRecord, from: string, to: string): string => {
    const text = textOf(plan);
    assert.ok(text.includes(from), `the plan's text does not hold ${from}:\n${text}`);
    return text.replace(from, to);
};

// The hash of what a form means, or null when it is refused.
const hashOfJson = (plan: unknown): string | null => {
    const parsed = parsePlan(plan);
    return parsed.ok ? planHash(parsed.value) : null;
};

const hashOfText = (text: string): string | null => {
    const read = readPlanText(text, limits);
    return read.ok ? hashOfJson(read.value.json) : null;
};

// Every object in the reading's JSON held under `key`, at any depth.
const mapsNamed = (value: unknown, key: string): readonly object[] => {
    if (typeof value !== "object" || value === null) {
        return [];
    }
    return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([name, nested]) => [
        ...(name === key && typeof nested === "object" && nested !== null ? [nested] : []),
        ...mapsNamed(nested, key),
    ]);
};

const MAP_CASES: readonly {
    readonly name: string;
    readonly plan: JsonRecord;
    readonly mapKey: string;
}[] = [
    { name: "a query", plan: queryPlan({ tab: "items" }), mapKey: "query" },
    { name: "a script's arguments", plan: argumentsPlan({ currency: "eur" }), mapKey: "arguments" },
    {
        name: "a step's remembered fields",
        plan: rememberPlan({ cartCount: "itemCount" }),
        mapKey: "remember",
    },
    { name: "an inline script's fields", plan: fieldsPlan({ blockCount: "/x" }), mapKey: "fields" },
];

describe("Using the readable plan format", () => {
    for (const { name, withoutKey, writtenText, textWithKey, jsonWithKey } of PROTOTYPE_KEY_CASES) {
        describe(`given ${name} holding a __proto__ key`, () => {
            describe("when its text form and its JSON form are both parsed", () => {
                test("then it should refuse both, or give both one hash", () => {
                    const text = changedText(withoutKey, writtenText, textWithKey);
                    assert.equal(hashOfText(text), hashOfJson(jsonWithKey));
                });
            });
        });
    }

    for (const { name, plan, mapKey } of MAP_CASES) {
        describe(`given ${name} in text`, () => {
            describe("when the text is read", () => {
                test("then it should hold the map with no prototype", () => {
                    const read = readPlanText(textOf(plan), limits);
                    assert.ok(read.ok, JSON.stringify(read));
                    const maps = mapsNamed(read.value.json, mapKey);
                    assert.ok(maps.length > 0, `the reading holds no ${mapKey} map`);
                    assert.deepEqual(
                        maps.map((map): unknown => Object.getPrototypeOf(map)),
                        maps.map(() => null),
                    );
                });

                test("then it should mean what its JSON form means", () => {
                    assert.notEqual(hashOfJson(plan), null);
                    assert.equal(hashOfText(textOf(plan)), hashOfJson(plan));
                });
            });
        });
    }

    describe("given a query with a key named after an object method", () => {
        describe("when its text form and its JSON form are both parsed", () => {
            test("then it should refuse both, or give both one hash", () => {
                const text = changedText(
                    queryPlan({ tab: "items" }),
                    'tab "items"',
                    'constructor "items"',
                );
                assert.equal(hashOfText(text), hashOfJson(queryPlan({ constructor: "items" })));
            });
        });
    });

    describe("given a query holding a value reference", () => {
        describe("when it is written and read back", () => {
            test("then it should keep the reference", () => {
                const plan = queryPlan({ highlight: reference("orderCode") });
                assert.notEqual(hashOfJson(plan), null);
                assert.equal(hashOfText(textOf(plan)), hashOfJson(plan));
            });
        });
    });
});
