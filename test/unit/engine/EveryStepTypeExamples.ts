// One or more plan steps of every step type the plan language has, each writing PLAIN_WORDS or
// PLAIN_PATH wherever its type takes free text. `satisfies` keeps the table complete, so adding a
// step type does not compile until it has examples here, and the tests over the table cover it.
import type { StepType, UnsafeFeature } from "@revisum/engine";
import { orderArguments } from "./service-call-examples.ts";
import {
    CLOSING_CHECK,
    REMEMBER_ATTRIBUTE,
    READ_CART,
    css,
    xpath,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";

export const PLAIN_WORDS = "Plain words";
export const PLAIN_PATH = "/plain-words";
export const DECLARED_FIXTURE = "avatar.png";

// A step, the steps it needs before it, and the unsafe features a plan holding them uses.
export type StepExample = {
    readonly name: string;
    readonly step: JsonRecord;
    readonly before?: readonly JsonRecord[];
    readonly unsafeFeatures?: readonly UnsafeFeature[];
};

const ROLE_NAMED = { by: "role", role: "button", name: PLAIN_WORDS };
const LABELLED = { by: "label", label: PLAIN_WORDS };
const STATUS = { by: "testId", testId: "status" };
const DOWNLOAD_NAME = "report";
const DOWNLOAD: JsonRecord = { type: "download", name: DOWNLOAD_NAME, locator: ROLE_NAMED };
const CRITERION = "cart.checked";

const checkOf = (fields: JsonRecord): JsonRecord => ({ ...fields, criterionId: CRITERION });

export const EVERY_STEP_TYPE_EXAMPLES = {
    navigate: [
        { name: "with a written path", step: { type: "navigate", url: PLAIN_PATH } },
        {
            name: "with a path template",
            step: {
                type: "navigate",
                url: { segments: ["orders", PLAIN_WORDS], query: { search: PLAIN_WORDS } },
            },
        },
    ],
    click: [
        { name: "by role", step: { type: "click", locator: ROLE_NAMED } },
        { name: "by label", step: { type: "click", locator: LABELLED } },
        { name: "by text", step: { type: "click", locator: { by: "text", text: PLAIN_WORDS } } },
        {
            name: "by test id",
            step: { type: "click", locator: { by: "testId", testId: PLAIN_WORDS } },
        },
        {
            name: "by css",
            step: {
                type: "click",
                locator: css(PLAIN_WORDS, { hasText: PLAIN_WORDS, position: "first" }),
            },
            unsafeFeatures: ["css-locator"],
        },
        {
            name: "by XPath",
            step: { type: "click", locator: xpath(PLAIN_WORDS, { position: "first" }) },
            unsafeFeatures: ["xpath-locator"],
        },
    ],
    hover: [{ name: "by role", step: { type: "hover", locator: ROLE_NAMED } }],
    fill: [
        { name: "of text", step: { type: "fill", locator: LABELLED, value: PLAIN_WORDS } },
        {
            name: "of several lines",
            step: { type: "fill", locator: LABELLED, value: { lines: [PLAIN_WORDS] } },
        },
    ],
    select: [
        { name: "of an option", step: { type: "select", locator: LABELLED, option: PLAIN_WORDS } },
    ],
    upload: [
        {
            name: "of a fixture",
            step: { type: "upload", locator: LABELLED, fixture: DECLARED_FIXTURE },
        },
    ],
    press: [
        {
            name: "of a key",
            step: { type: "press", locator: LABELLED, key: "Enter", modifiers: ["Shift"] },
        },
    ],
    frame: [
        {
            name: "by test id",
            step: {
                type: "frame",
                locator: { by: "testId", testId: PLAIN_WORDS },
                steps: [CLOSING_CHECK],
            },
        },
    ],
    dialog: [
        {
            name: "with expected text",
            step: { type: "dialog", action: "accept", expectText: PLAIN_WORDS },
        },
    ],
    expect: [
        {
            name: "of text",
            step: checkOf({
                type: "expect",
                locator: STATUS,
                assert: { kind: "textContains", value: PLAIN_WORDS },
            }),
        },
        {
            name: "of a computed style",
            step: checkOf({
                type: "expect",
                locator: STATUS,
                assert: {
                    kind: "computedStyleEquals",
                    property: "color",
                    value: PLAIN_WORDS,
                },
            }),
            unsafeFeatures: ["dom-checks"],
        },
        {
            name: "of an attribute",
            step: checkOf({
                type: "expect",
                locator: STATUS,
                assert: { kind: "attributeEquals", name: "title", value: PLAIN_WORDS },
            }),
            unsafeFeatures: ["dom-checks"],
        },
    ],
    expectPage: [
        {
            name: "of the title",
            step: checkOf({ type: "expectPage", assert: { kind: "title", value: PLAIN_WORDS } }),
        },
        {
            name: "of a meta tag",
            step: checkOf({
                type: "expectPage",
                assert: { kind: "metaContent", name: PLAIN_WORDS, value: PLAIN_WORDS },
            }),
        },
        {
            name: "of the url path's start",
            step: checkOf({
                type: "expectPage",
                assert: { kind: "urlPathStartsWith", value: PLAIN_PATH },
            }),
        },
        {
            name: "of the canonical url",
            step: checkOf({
                type: "expectPage",
                assert: { kind: "canonicalUrl", value: PLAIN_PATH },
            }),
        },
    ],
    a11yAudit: [{ name: "reporting", step: { type: "a11yAudit", mode: "report" } }],
    capture: [{ name: "named", step: { type: "capture", name: "cart" } }],
    remember: [
        { name: "of an attribute", step: REMEMBER_ATTRIBUTE, unsafeFeatures: ["dom-checks"] },
        {
            name: "of an element's text",
            step: {
                type: "remember",
                name: "orderId",
                from: { element: ROLE_NAMED, read: "text" },
            },
        },
    ],
    download: [{ name: "by role", step: DOWNLOAD }],
    expectDownload: [
        {
            name: "of its file name",
            before: [DOWNLOAD],
            step: checkOf({
                type: "expectDownload",
                download: DOWNLOAD_NAME,
                assert: { kind: "fileNameEquals", value: PLAIN_WORDS },
            }),
        },
    ],
    newTab: [
        {
            name: "at a written path",
            step: { type: "newTab", url: PLAIN_PATH, steps: [CLOSING_CHECK] },
        },
    ],
    call: [
        {
            name: "with text arguments",
            step: {
                type: "call",
                call: "createOrder",
                arguments: orderArguments({ customerName: PLAIN_WORDS }),
                remember: { orderId: "orderId" },
            },
        },
    ],
    expectBackend: [
        {
            name: "of a field's text",
            step: checkOf({
                type: "expectBackend",
                call: "getOrder",
                arguments: { orderId: "ord_1" },
                field: "status",
                assert: { kind: "equals", value: PLAIN_WORDS },
            }),
        },
    ],
    stub: [
        {
            name: "starting with text arguments",
            step: {
                type: "stub",
                stub: "loginNeedsCode",
                action: "start",
                arguments: { reason: PLAIN_WORDS },
            },
        },
    ],
    resetRequests: [
        { name: "of a declared request", step: { type: "resetRequests", request: "likes" } },
    ],
    expectRequests: [
        {
            name: "counting a declared request",
            step: checkOf({ type: "expectRequests", request: "likes", count: { equals: 1 } }),
        },
    ],
    expectResponse: [
        {
            name: "of a field's text",
            step: checkOf({
                type: "expectResponse",
                request: "likes",
                assert: { kind: "fieldEquals", field: "firstLiker", value: PLAIN_WORDS },
            }),
        },
    ],
    setStorage: [
        {
            name: "of a declared entry",
            step: { type: "setStorage", entry: "pinnedMenu", arguments: { docked: false } },
        },
    ],
    removeStorage: [
        { name: "of a declared entry", step: { type: "removeStorage", entry: "pinnedMenu" } },
    ],
    expectStorage: [
        {
            name: "of its text",
            step: checkOf({
                type: "expectStorage",
                entry: "pinnedMenu",
                assert: { kind: "equals", value: PLAIN_WORDS },
            }),
        },
    ],
    advanceClock: [
        {
            name: "by an amount",
            step: { type: "advanceClock", by: { amount: 30, unit: "seconds" }, mode: "runTimers" },
        },
    ],
    expectClipboard: [
        {
            name: "of its text",
            step: checkOf({
                type: "expectClipboard",
                assert: { kind: "textEquals", value: PLAIN_WORDS },
            }),
        },
    ],
    evaluate: [
        { name: "of a declared script", step: READ_CART, unsafeFeatures: ["page-script"] },
        {
            name: "of a declared script with text arguments",
            step: { type: "evaluate", script: "seedEditor", arguments: { text: PLAIN_WORDS } },
            unsafeFeatures: ["page-script"],
        },
        {
            name: "of an inline script",
            step: {
                type: "evaluate",
                script: { inline: { source: PLAIN_WORDS, effect: "read" } },
                arguments: {},
            },
            unsafeFeatures: ["inline-page-script"],
        },
    ],
    expectScript: [
        {
            name: "of a field's text",
            step: checkOf({
                type: "expectScript",
                script: "readCart",
                arguments: { currency: "eur" },
                field: "itemCount",
                assert: { kind: "equals", value: PLAIN_WORDS },
            }),
            unsafeFeatures: ["page-script"],
        },
    ],
    database: [
        {
            name: "of a declared command",
            step: { type: "database", command: "seedOrders", arguments: { count: 3 } },
            unsafeFeatures: ["database-command"],
        },
    ],
    expectDatabase: [
        {
            name: "of a field's text",
            step: checkOf({
                type: "expectDatabase",
                command: "countOrders",
                arguments: { email: "ada@example.com" },
                field: "count",
                assert: { kind: "equals", value: PLAIN_WORDS },
            }),
            unsafeFeatures: ["database-command"],
        },
    ],
} as const satisfies Readonly<Record<StepType, readonly StepExample[]>>;
