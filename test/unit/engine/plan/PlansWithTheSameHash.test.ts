// A plan's hash ignores the order of map keys, and an approval follows the hash. So two plans with
// one hash are one plan: they must go to the same URL and read as the same text, whichever order
// their keys were written in.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planHash, writePlanText } from "@revisum/engine";
import {
    accepted,
    navigate,
    parserFor,
    planOf,
    reference,
    runPlan,
    type JsonRecord,
    type ParsePlan,
} from "../run/values/examples/RunPlan.ts";
import { parserEnabling } from "./unsafe-features/examples/LostByFeature.ts";
import { FEATURES, OPEN_CART, unsafePlan } from "./unsafe-features/examples/UnsafePlan.ts";

const parseClosed = parserFor();
const parseWithFeatures = parserEnabling(FEATURES);

const ordersPage = (query: JsonRecord): JsonRecord =>
    planOf([navigate({ segments: ["orders"], query })]);

const QUERY_KEYS_ONE_WAY = ordersPage({ tab: "items", highlight: "new" });
const QUERY_KEYS_OTHER_WAY = ordersPage({ highlight: "new", tab: "items" });

const OPEN_BOTH_VALUES = navigate({ segments: [reference("first"), reference("second")] });
const FIRST_VALUE = { kind: "uniqueText", prefix: "first" };
const SECOND_VALUE = { kind: "uniqueText", prefix: "second" };
const VALUES_ONE_WAY = planOf([OPEN_BOTH_VALUES], {
    values: { first: FIRST_VALUE, second: SECOND_VALUE },
});
const VALUES_OTHER_WAY = planOf([OPEN_BOTH_VALUES], {
    values: { second: SECOND_VALUE, first: FIRST_VALUE },
});

const inlineRead = (fields: JsonRecord, remember: JsonRecord): JsonRecord =>
    unsafePlan([
        OPEN_CART,
        {
            type: "evaluate",
            script: { inline: { source: "() => ({})", effect: "read", fields } },
            arguments: {},
            remember,
        },
    ]);

const REORDERED_PLANS: readonly {
    readonly name: string;
    readonly parse: ParsePlan;
    readonly oneWay: JsonRecord;
    readonly otherWay: JsonRecord;
}[] = [
    {
        name: "query keys",
        parse: parseClosed,
        oneWay: QUERY_KEYS_ONE_WAY,
        otherWay: QUERY_KEYS_OTHER_WAY,
    },
    {
        name: "values",
        parse: parseClosed,
        oneWay: VALUES_ONE_WAY,
        otherWay: VALUES_OTHER_WAY,
    },
    {
        name: "inline script fields",
        parse: parseWithFeatures,
        oneWay: inlineRead({ left: "/left", right: "/right" }, { remembered: "left" }),
        otherWay: inlineRead({ right: "/right", left: "/left" }, { remembered: "left" }),
    },
    {
        name: "remembered fields",
        parse: parseWithFeatures,
        oneWay: inlineRead(
            { left: "/left", right: "/right" },
            { rememberedLeft: "left", rememberedRight: "right" },
        ),
        otherWay: inlineRead(
            { left: "/left", right: "/right" },
            { rememberedRight: "right", rememberedLeft: "left" },
        ),
    },
];

const REORDERED_RUNS: readonly {
    readonly name: string;
    readonly oneWay: JsonRecord;
    readonly otherWay: JsonRecord;
}[] = [
    { name: "query keys", oneWay: QUERY_KEYS_ONE_WAY, otherWay: QUERY_KEYS_OTHER_WAY },
    { name: "values", oneWay: VALUES_ONE_WAY, otherWay: VALUES_OTHER_WAY },
];

describe("Using a plan's hash", () => {
    for (const { name, parse, oneWay, otherWay } of REORDERED_PLANS) {
        describe(`given two plans that differ only in the order of their ${name}`, () => {
            describe("when each is parsed", () => {
                test("then it should give them one hash", () => {
                    assert.equal(
                        planHash(accepted(parse, oneWay)),
                        planHash(accepted(parse, otherWay)),
                    );
                });
            });

            describe("when each is written as text", () => {
                test("then it should give them one text", () => {
                    assert.equal(
                        writePlanText(accepted(parse, oneWay)),
                        writePlanText(accepted(parse, otherWay)),
                    );
                });
            });
        });
    }

    for (const { name, oneWay, otherWay } of REORDERED_RUNS) {
        describe(`given two runs of plans that differ only in the order of their ${name}`, () => {
            describe("when each navigates under the same seed", () => {
                test("then it should go to the same URL", async () => {
                    const first = await runPlan(oneWay);
                    const second = await runPlan(otherWay);
                    assert.ok(first.recording.navigations.length > 0, "nothing was navigated to");
                    assert.deepEqual(first.recording.navigations, second.recording.navigations);
                });
            });
        });
    }

    describe("given two plans whose query values differ", () => {
        describe("when each is parsed and written as text", () => {
            test("then it should give them two hashes and two texts", () => {
                const first = accepted(parseClosed, ordersPage({ tab: "items" }));
                const second = accepted(parseClosed, ordersPage({ tab: "notes" }));
                assert.notEqual(planHash(first), planHash(second));
                assert.notEqual(writePlanText(first), writePlanText(second));
            });
        });
    });
});
