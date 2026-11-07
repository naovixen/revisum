// Each step type's reader must keep every field the plan language gives that type, required and
// optional. The fields are read from the published JSON Schema, which lists them from the same table
// the parser does, and each step below writes all of them, so a reader that drops one is caught.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planJsonSchema, type StepType } from "@revisum/engine";
import { parserEnabling } from "./unsafe-feature-examples.ts";
import {
    CART_COUNT_CHECK,
    CLOSING_CHECK,
    FEATURES,
    ORDER_COUNT_CHECK,
    READ_CART,
    REMEMBER_ATTRIBUTE,
    unsafePlan,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";
import { orderArguments } from "./service-call-examples.ts";

const DECLARED_FIXTURE = "avatar.png";
const parsePlan = parserEnabling(FEATURES, { fixtures: [DECLARED_FIXTURE] });

const STATUS = { by: "testId", testId: "status" };
const DOWNLOAD_NAME = "report";

// A step of the type that writes every field the type has, and the steps it needs before it.
type FullStep = { readonly step: JsonRecord; readonly before?: readonly JsonRecord[] };

const DOWNLOAD: JsonRecord = {
    type: "download",
    name: DOWNLOAD_NAME,
    locator: { by: "role", role: "button", name: "Export" },
};

const FULL_STEPS = {
    navigate: { step: { type: "navigate", url: "/cart", scripts: "disabled" } },
    click: { step: { type: "click", locator: { by: "role", role: "button", name: "Pay" } } },
    hover: { step: { type: "hover", locator: { by: "role", role: "button", name: "Help" } } },
    fill: {
        step: { type: "fill", locator: { by: "label", label: "Name" }, value: "Ada Lovelace" },
    },
    select: {
        step: { type: "select", locator: { by: "label", label: "Region" }, option: "Europe" },
    },
    upload: {
        step: {
            type: "upload",
            locator: { by: "label", label: "Avatar" },
            fixture: DECLARED_FIXTURE,
        },
    },
    press: {
        step: {
            type: "press",
            locator: { by: "label", label: "Search" },
            key: "Enter",
            modifiers: ["Shift"],
        },
    },
    frame: {
        step: {
            type: "frame",
            locator: { by: "testId", testId: "editor" },
            steps: [CLOSING_CHECK],
        },
    },
    dialog: { step: { type: "dialog", action: "accept", expectText: "Are you sure?" } },
    expect: {
        step: {
            type: "expect",
            locator: STATUS,
            assert: { kind: "textContains", value: "Paid" },
            criterionId: "cart.paid",
        },
    },
    expectPage: {
        step: {
            type: "expectPage",
            assert: { kind: "urlPath", value: "/goodbye" },
            criterionId: "cart.farewell",
        },
    },
    a11yAudit: { step: { type: "a11yAudit", mode: "report" } },
    capture: { step: { type: "capture", name: "cart" } },
    remember: { step: REMEMBER_ATTRIBUTE },
    download: { step: DOWNLOAD },
    expectDownload: {
        before: [DOWNLOAD],
        step: {
            type: "expectDownload",
            download: DOWNLOAD_NAME,
            assert: { kind: "fileNameEquals", value: "report.csv" },
            criterionId: "cart.report-named",
        },
    },
    newTab: { step: { type: "newTab", url: "/orders", steps: [CLOSING_CHECK] } },
    call: {
        step: {
            type: "call",
            call: "createOrder",
            arguments: orderArguments(),
            remember: { orderId: "orderId" },
        },
    },
    expectBackend: {
        step: {
            type: "expectBackend",
            call: "getOrder",
            arguments: { orderId: "ord_1" },
            field: "status",
            assert: { kind: "equals", value: "paid" },
            criterionId: "cart.order-paid",
        },
    },
    stub: {
        step: {
            type: "stub",
            stub: "loginNeedsCode",
            action: "start",
            arguments: { reason: "Enter the code from your app" },
        },
    },
    resetRequests: { step: { type: "resetRequests", request: "likes" } },
    expectRequests: {
        step: {
            type: "expectRequests",
            request: "likes",
            count: { equals: 1 },
            criterionId: "cart.liked-once",
        },
    },
    expectResponse: {
        step: {
            type: "expectResponse",
            request: "likes",
            assert: { kind: "statusEquals", value: 200 },
            criterionId: "cart.likes-loaded",
        },
    },
    setStorage: { step: { type: "setStorage", entry: "pinnedMenu", arguments: { docked: false } } },
    removeStorage: { step: { type: "removeStorage", entry: "pinnedMenu" } },
    expectStorage: {
        step: {
            type: "expectStorage",
            entry: "pinnedMenu",
            assert: { kind: "equals", value: "false" },
            criterionId: "cart.menu-undocked",
        },
    },
    advanceClock: {
        step: { type: "advanceClock", by: { amount: 30, unit: "seconds" }, mode: "runTimers" },
    },
    expectClipboard: {
        step: {
            type: "expectClipboard",
            assert: { kind: "textEquals", value: "Join us" },
            criterionId: "cart.invite-copied",
        },
    },
    evaluate: { step: READ_CART },
    expectScript: { step: CART_COUNT_CHECK },
    database: {
        step: {
            type: "database",
            command: "countOrders",
            arguments: { email: "ada@example.com" },
            remember: { orderCount: "count" },
        },
    },
    expectDatabase: { step: ORDER_COUNT_CHECK },
} as const satisfies Record<StepType, FullStep>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isListedStepType = (key: string): key is StepType => Object.hasOwn(FULL_STEPS, key);

// The fields the published schema gives a step type, which it reads from the plan language's table.
const schemaFieldsOf = (type: StepType): readonly string[] => {
    const definitions: unknown = planJsonSchema()["$defs"];
    assert.ok(isRecord(definitions));
    const definition = definitions[`${type}Step`];
    assert.ok(isRecord(definition), `the schema defines ${type} steps`);
    const properties = definition["properties"];
    assert.ok(isRecord(properties));
    return Object.keys(properties).toSorted();
};

const parsedStepOf = (type: StepType): Readonly<Record<string, unknown>> => {
    const { step, before = [] }: FullStep = FULL_STEPS[type];
    const parsed = parsePlan(unsafePlan([...before, step]));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const parsedStep: unknown = parsed.value.steps[before.length];
    assert.ok(isRecord(parsedStep));
    return parsedStep;
};

describe("Using the plan parser", () => {
    for (const stepType of Object.keys(FULL_STEPS).filter(isListedStepType)) {
        const { step }: FullStep = FULL_STEPS[stepType];

        describe(`given a step of type ${stepType} writing every field the plan language gives it`, () => {
            describe("when the schema's fields for the type are listed", () => {
                test("then it should write exactly those fields", () => {
                    assert.deepEqual(Object.keys(step).toSorted(), schemaFieldsOf(stepType));
                });
            });

            describe("when the plan is parsed", () => {
                test("then it should keep every field with the value written", () => {
                    const parsedStep = parsedStepOf(stepType);
                    const kept = Object.fromEntries(
                        Object.keys(step).map((field) => [field, parsedStep[field]]),
                    );
                    assert.deepEqual(kept, step);
                });
            });
        });
    }
});
