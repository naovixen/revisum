// Text that holds nothing but white space is found inside any text, so a check against it proves
// nothing. Written in the plan, it is refused when the plan is parsed. Remembered at run time, such
// as an API answering {"id":""}, it fails with value-empty, whichever step remembered it and
// whichever step compares against it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success, type ElementProbe, type Locator, type RunResult } from "@revisum/engine";
import { accepted } from "../../run/values/examples/RunPlan.ts";
import {
    NO_ELEMENT,
    SHOWN_ELEMENT,
    fakeNetwork,
    fakeSessionOnOrders,
    likesExchange,
    runOnFakeSession,
} from "../../run/examples/RunOnFakeSession.ts";
import {
    jsonReply,
    requestLine,
    shopWith,
    type Route,
} from "../../run/executors/service-calls/examples/ShopService.ts";
import { parserEnabling, rejection } from "../unsafe-features/examples/LostByFeature.ts";
import { OPEN_CART, unsafePlan, type JsonRecord } from "../unsafe-features/examples/UnsafePlan.ts";
import { StepOutcome, SemanticLocatorKind } from "@revisum/contracts";

const STATUS: JsonRecord = { by: "testId", testId: "status" };
const EXPORT_BUTTON: JsonRecord = { by: "role", role: "button", name: "Export" };
const EMAIL = "ada@example.com";
const CREATE_ORDER_ARGUMENTS: JsonRecord = {
    customerName: "Ada Lovelace",
    contactEmail: EMAIL,
    quantity: 2,
    region: "eu",
    giftWrap: false,
    deliveryDay: "2026-11-02",
};

const elementCheck = (kind: string, value: unknown): JsonRecord => ({
    type: "expect",
    locator: STATUS,
    assert: { kind, value },
    criterionId: "status.text-shown",
});
const DOWNLOAD: JsonRecord = { type: "download", name: "report", locator: EXPORT_BUTTON };
const contentCheck = (value: unknown): JsonRecord => ({
    type: "expectDownload",
    download: "report",
    assert: { kind: "contentContains", value },
    criterionId: "report.content-checked",
});
const clipboardCheck = (value: unknown): JsonRecord => ({
    type: "expectClipboard",
    assert: { kind: "textContains", value },
    criterionId: "invite.link-copied",
});
const backendCheck = (value: unknown): JsonRecord => ({
    type: "expectBackend",
    call: "getOrder",
    arguments: { orderId: "ord_1042" },
    field: "status",
    assert: { kind: "contains", value },
    criterionId: "orders.backend-state",
});
const responseCheck = (value: unknown): JsonRecord => ({
    type: "expectResponse",
    request: "likes",
    assert: { kind: "fieldContains", field: "firstLiker", value },
    criterionId: "likes.answer-checked",
});
const scriptCheck = (value: unknown): JsonRecord => ({
    type: "expectScript",
    script: "readCart",
    arguments: { currency: "eur" },
    field: "itemCount",
    assert: { kind: "contains", value },
    criterionId: "cart.count-checked",
});
const databaseCheck = (value: unknown): JsonRecord => ({
    type: "expectDatabase",
    command: "countOrders",
    arguments: { email: EMAIL },
    field: "count",
    assert: { kind: "contains", value },
    criterionId: "orders.count-checked",
});

// Every check that compares against expected text. `before` holds the steps it needs first.
const TEXT_CHECKS: readonly {
    readonly name: string;
    readonly check: (value: unknown) => JsonRecord;
    readonly before: readonly JsonRecord[];
}[] = [
    { name: "textContains", check: (value) => elementCheck("textContains", value), before: [] },
    { name: "textEquals", check: (value) => elementCheck("textEquals", value), before: [] },
    { name: "valueContains", check: (value) => elementCheck("valueContains", value), before: [] },
    { name: "contentContains on a download", check: contentCheck, before: [DOWNLOAD] },
    { name: "textContains on the clipboard", check: clipboardCheck, before: [] },
    { name: "contains on a backend field", check: backendCheck, before: [] },
    { name: "fieldContains on a response", check: responseCheck, before: [] },
    { name: "contains on a script's field", check: scriptCheck, before: [] },
    { name: "contains on a database field", check: databaseCheck, before: [] },
];

const REFERENCE: JsonRecord = { valueName: "orderId" };

const createOrderRemembering: JsonRecord = {
    type: "call",
    call: "createOrder",
    arguments: CREATE_ORDER_ARGUMENTS,
    remember: { orderId: "orderId" },
};

// The fake world: every text a check can read holds "Ready", and the order id is what the test says.
const shopAnsweringOrderId = (orderId: string): Route =>
    shopWith((request) => {
        const line = requestLine(request);
        if (line === "POST /api/orders") {
            return jsonReply(201, { id: orderId, status: "pending" });
        }
        return line === "GET /api/orders/ord_1042"
            ? jsonReply(200, { status: "Ready to ship", total: 1 })
            : undefined;
    });

const probeOf = (locator: Locator): Promise<ElementProbe> =>
    Promise.resolve(locator.by === SemanticLocatorKind.Text ? NO_ELEMENT : SHOWN_ELEMENT);

const readyWorld = (scriptField: string) =>
    fakeSessionOnOrders({
        probe: probeOf,
        download: () =>
            Promise.resolve(
                success({
                    fileName: "report.csv",
                    mediaType: "text/csv",
                    bytes: new TextEncoder().encode("Ready report"),
                    sha256: "0".repeat(64),
                }),
            ),
        clipboard: { readText: () => Promise.resolve(success("Ready link")) },
        network: fakeNetwork([likesExchange(200, "Ready Ada")]),
        runScript: () => Promise.resolve(success(JSON.stringify({ count: scriptField }))),
    });

const databaseAnswering = (count: string) => () => ({ stdout: JSON.stringify({ count }) });

function assertFailedWithValueEmpty(result: RunResult): void {
    assert.notEqual(result.state, "Passed", JSON.stringify(result.steps));
    const firstFailed = result.steps.find((step) => step.outcome === StepOutcome.Failed);
    assert.equal(firstFailed?.code, "value-empty", JSON.stringify(result.steps));
}

const planRememberingOrderIdThen = (steps: readonly JsonRecord[]): JsonRecord =>
    unsafePlan([createOrderRemembering, OPEN_CART, ...steps]);

// Steps that take a run value from somewhere other than a call, and how the world gives them text.
const REMEMBERING_STEPS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly valueName: string;
}[] = [
    {
        name: "an evaluate",
        step: {
            type: "evaluate",
            script: "readCart",
            arguments: { currency: "eur" },
            remember: { cartCount: "itemCount" },
        },
        valueName: "cartCount",
    },
    {
        name: "a database step",
        step: {
            type: "database",
            command: "countOrders",
            arguments: { email: EMAIL },
            remember: { orderCount: "count" },
        },
        valueName: "orderCount",
    },
];

const absentByTextOf = (value: unknown): JsonRecord => ({
    type: "expect",
    locator: { by: "text", text: value },
    assert: { kind: "absent" },
    criterionId: "status.error-gone",
});

describe("Using the plan parser", () => {
    const parsePlan = parserEnabling();

    for (const { name, check, before } of TEXT_CHECKS) {
        describe(`given a ${name} check whose expected text is only spaces`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the text as vacuous", () => {
                    const index = before.length + 1;
                    const raw = unsafePlan([OPEN_CART, ...before, check("  ")]);
                    assert.deepEqual(rejection(parsePlan, raw), [
                        `vacuous $.steps[${index}].assert.value`,
                    ]);
                });
            });
        });

        describe(`given a ${name} check whose expected text holds words and spaces`, () => {
            describe("when the plan is parsed", () => {
                test("then it should accept it", () => {
                    const parsed = parsePlan(
                        unsafePlan([OPEN_CART, ...before, check(" Ready to ship ")]),
                    );
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    accepted(parsePlan, unsafePlan([OPEN_CART, ...before, check("Ready")]));
                });
            });
        });
    }
});

describe("Using the run", () => {
    for (const { name, check, before } of TEXT_CHECKS) {
        describe(`given a ${name} check against a value a call remembered`, () => {
            describe("and the API answered that value empty", () => {
                describe("when the run reaches the check", () => {
                    test("then it should fail with value-empty", async () => {
                        const { result } = await runOnFakeSession(
                            planRememberingOrderIdThen([...before, check(REFERENCE)]),
                            {
                                session: readyWorld("Ready 3"),
                                serviceRoute: shopAnsweringOrderId(""),
                                commandRoute: databaseAnswering("Ready 3"),
                            },
                        );
                        assertFailedWithValueEmpty(result);
                    });
                });
            });

            describe("and the API answered that value with text the check can find", () => {
                describe("when the run reaches the check", () => {
                    test("then it should pass", async () => {
                        const { result } = await runOnFakeSession(
                            planRememberingOrderIdThen([...before, check(REFERENCE)]),
                            {
                                session: readyWorld("Ready"),
                                serviceRoute: shopAnsweringOrderId("Ready"),
                                commandRoute: databaseAnswering("Ready"),
                            },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }

    describe("given a textContains check against a value a call remembered", () => {
        describe("and the API answered that value with only spaces", () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with value-empty", async () => {
                    const { result } = await runOnFakeSession(
                        planRememberingOrderIdThen([elementCheck("textContains", REFERENCE)]),
                        {
                            session: readyWorld("Ready 3"),
                            serviceRoute: shopAnsweringOrderId("   "),
                        },
                    );
                    assertFailedWithValueEmpty(result);
                });
            });
        });
    });

    describe("given an absent check of an element found by a value a call remembered", () => {
        describe("and the API answered that value empty", () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with value-empty", async () => {
                    const { result } = await runOnFakeSession(
                        planRememberingOrderIdThen([absentByTextOf(REFERENCE)]),
                        { session: readyWorld("Ready 3"), serviceRoute: shopAnsweringOrderId("") },
                    );
                    assertFailedWithValueEmpty(result);
                });
            });
        });
    });

    for (const { name, step, valueName } of REMEMBERING_STEPS) {
        const plan = unsafePlan([OPEN_CART, step, elementCheck("textContains", { valueName })]);

        describe(`given a textContains check against a value ${name} remembered`, () => {
            describe("and that value came back empty", () => {
                describe("when the run reaches the check", () => {
                    test("then it should fail with value-empty", async () => {
                        const { result } = await runOnFakeSession(plan, {
                            session: readyWorld(""),
                            commandRoute: databaseAnswering(""),
                        });
                        assertFailedWithValueEmpty(result);
                    });
                });
            });

            describe("and that value came back with text the check can find", () => {
                describe("when the run reaches the check", () => {
                    test("then it should pass", async () => {
                        const { result } = await runOnFakeSession(plan, {
                            session: readyWorld("Ready"),
                            commandRoute: databaseAnswering("Ready"),
                        });
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }
});
