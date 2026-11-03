// A remembered value is hashed into the result and a later step can send it on, and a hash of a short
// secret is as good as the secret. So a value that holds one of the plan's secrets is refused wherever
// it was read from: a response, the clipboard, a page script, a database command, a declared call or
// the page itself.
// All values here are made up for the test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { environmentSecretStore, success, type RunResult, type Session } from "@revisum/engine";
import { DATABASE_PASSWORD } from "./database-command-examples.ts";
import {
    fakeNetwork,
    fakeSession,
    likesExchange,
    runOnFakeSession,
    type FakeRunOptions,
} from "./RunOnFakeSession.ts";
import { echoForms } from "./secret-examples.ts";
import { jsonReply, requestLine, shopWith } from "./service-call-examples.ts";
import { DATABASE_SECRET, OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";

const SHORT_SECRET = "4821";
const ORDINARY_VALUE = "Ada";

const FILL_SECRET: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Access code" },
    value: { secretName: DATABASE_SECRET },
};
const REMEMBER_STEP_INDEX = 2;

// How a route is told what its source holds: each gives its step and what the run needs to read it.
const ROUTES: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly holding: (value: string) => FakeRunOptions;
}[] = [
    {
        name: "a response",
        step: {
            type: "remember",
            name: "firstName",
            from: { response: "likes", field: "firstLiker", read: "text" },
        },
        holding: (value) => ({
            session: fakeSession({ network: fakeNetwork([likesExchange(200, value)]) }),
        }),
    },
    {
        name: "the clipboard",
        step: { type: "remember", name: "copiedText", from: { clipboard: "text" } },
        holding: (value) => ({
            session: fakeSession({
                clipboard: { readText: () => Promise.resolve(success(value)) },
            }),
        }),
    },
    {
        name: "a page script",
        step: {
            type: "evaluate",
            script: "readCart",
            arguments: { currency: "eur" },
            remember: { cartCount: "itemCount" },
        },
        holding: (value) => ({
            session: fakeSession({
                runScript: () => Promise.resolve(success(JSON.stringify({ count: value }))),
            }),
        }),
    },
    {
        name: "a database command",
        step: {
            type: "database",
            command: "countOrders",
            arguments: { email: "ada@example.com" },
            remember: { orderCount: "count" },
        },
        holding: (value) => ({
            commandRoute: () => ({ stdout: JSON.stringify({ count: value }) }),
        }),
    },
    {
        name: "the page",
        step: {
            type: "remember",
            name: "shownCode",
            from: { element: { by: "testId", testId: "shown-code" }, read: "text" },
        },
        holding: (value) => {
            const probe: Session["probe"] = () =>
                Promise.resolve({
                    count: 1,
                    visible: true,
                    enabled: true,
                    text: value,
                    value: null,
                    sensitive: false,
                    box: null,
                });
            return { session: fakeSession({ probe }) };
        },
    },
];

const FORMS_OF_THE_SECRET: readonly {
    readonly name: string;
    readonly written: (secret: string) => string;
}[] = [
    { name: "the secret itself", written: (secret) => secret },
    { name: "the secret inside longer text", written: (secret) => `token=${secret} ok` },
    { name: "the secret in other case", written: (secret) => echoForms(secret).upper },
    { name: "the secret URL-encoded", written: (secret) => echoForms(secret).uri },
    { name: "the secret in base64", written: (secret) => echoForms(secret).base64 },
    { name: "the secret cut short", written: (secret) => echoForms(secret).prefix },
];

// A call keeps its values without a record of their own: its result records the response by sha256.
const CREATE_ORDER_REMEMBERING: JsonRecord = {
    type: "call",
    call: "createOrder",
    arguments: {
        customerName: "Ada Lovelace",
        contactEmail: "ada@example.com",
        quantity: 2,
        region: "eu",
        giftWrap: false,
        deliveryDay: "2026-11-02",
    },
    remember: { orderId: "orderId" },
};

const shopAnsweringOrderId = (orderId: string): FakeRunOptions => ({
    serviceRoute: shopWith((request) =>
        requestLine(request) === "POST /api/orders"
            ? jsonReply(201, { id: orderId, status: "pending" })
            : undefined,
    ),
});

const planRemembering = (step: JsonRecord): JsonRecord =>
    unsafePlan([OPEN_CART, FILL_SECRET, step]);

const rememberedKeys = (result: RunResult): readonly string[] =>
    Object.keys(result.steps[REMEMBER_STEP_INDEX] ?? {}).filter((key) =>
        key.startsWith("remembered"),
    );

function assertRefused(result: RunResult): void {
    assert.equal(
        result.steps[REMEMBER_STEP_INDEX]?.code,
        "value-holds-secret",
        JSON.stringify(result.steps),
    );
    assert.equal(result.steps[REMEMBER_STEP_INDEX].outcome, "failed");
    assert.deepEqual(rememberedKeys(result), []);
    assert.equal(result.steps[REMEMBER_STEP_INDEX + 1]?.outcome, "skipped");
}

describe("Using a run that remembers a value", () => {
    for (const { name, step, holding } of ROUTES) {
        describe(`given a value read from ${name}`, () => {
            for (const form of FORMS_OF_THE_SECRET) {
                describe(`and it holds ${form.name}`, () => {
                    describe("when the step runs", () => {
                        test("then it should refuse the value with value-holds-secret", async () => {
                            const { result } = await runOnFakeSession(
                                planRemembering(step),
                                holding(form.written(DATABASE_PASSWORD)),
                            );
                            assertRefused(result);
                        });

                        test("then it should log no remembered value", async () => {
                            const { events } = await runOnFakeSession(
                                planRemembering(step),
                                holding(form.written(DATABASE_PASSWORD)),
                            );
                            assert.equal(
                                events.read().some((event) => event.kind === "value.remembered"),
                                false,
                            );
                        });
                    });
                });
            }

            describe("and it is exactly a secret too short to search for", () => {
                describe("when the step runs", () => {
                    test("then it should refuse the value with value-holds-secret", async () => {
                        const { result } = await runOnFakeSession(planRemembering(step), {
                            ...holding(SHORT_SECRET),
                            secrets: environmentSecretStore({ [DATABASE_SECRET]: SHORT_SECRET }),
                        });
                        assertRefused(result);
                    });
                });
            });

            describe("and it holds no secret", () => {
                describe("when the step runs", () => {
                    test("then it should remember it", async () => {
                        const { result } = await runOnFakeSession(
                            planRemembering(step),
                            holding(ORDINARY_VALUE),
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.equal(rememberedKeys(result).length, 1);
                    });
                });
            });
        });
    }

    describe("given a value read from a declared call's response", () => {
        for (const form of FORMS_OF_THE_SECRET) {
            describe(`and it holds ${form.name}`, () => {
                describe("when the step runs", () => {
                    test("then it should refuse the value with value-holds-secret", async () => {
                        const { result } = await runOnFakeSession(
                            planRemembering(CREATE_ORDER_REMEMBERING),
                            shopAnsweringOrderId(form.written(DATABASE_PASSWORD)),
                        );
                        assertRefused(result);
                    });
                });
            });
        }

        describe("and it is exactly a secret too short to search for", () => {
            describe("when the step runs", () => {
                test("then it should refuse the value with value-holds-secret", async () => {
                    const { result } = await runOnFakeSession(
                        planRemembering(CREATE_ORDER_REMEMBERING),
                        {
                            ...shopAnsweringOrderId(SHORT_SECRET),
                            secrets: environmentSecretStore({ [DATABASE_SECRET]: SHORT_SECRET }),
                        },
                    );
                    assertRefused(result);
                });
            });
        });

        describe("and it holds no secret", () => {
            describe("when the step runs", () => {
                test("then it should keep it", async () => {
                    const { result } = await runOnFakeSession(
                        planRemembering(CREATE_ORDER_REMEMBERING),
                        shopAnsweringOrderId(ORDINARY_VALUE),
                    );
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    });
});
