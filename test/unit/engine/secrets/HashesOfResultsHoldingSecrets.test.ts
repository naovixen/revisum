// A hash of text holding a secret lets anyone who can guess the rest try secrets against it offline,
// so what a run keeps of a response, a script's result or a command's output has no hash once it holds
// one of the run's secrets, in any form. Every other result keeps its exact hash. All values here are
// made up for the test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    sha256,
    success,
    type LoggedEvent,
    type RunResult,
    type StepResult,
} from "@revisum/engine";
import { DATABASE_PASSWORD } from "../run/executors/database-commands/examples/Database.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "../run/examples/RunOnFakeSession.ts";
import { echoForms } from "./examples/SecretRun.ts";
import {
    ORDER_ID,
    SECRET_VALUES,
    TOKEN_SECRET,
    callPlanOf,
    expectBackend,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
} from "../run/executors/service-calls/examples/ShopService.ts";
import { DATABASE_SECRET, OPEN_CART, unsafePlan, type JsonRecord } from "../plan/unsafe-features/examples/UnsafePlan.ts";

const TOKEN = SECRET_VALUES[TOKEN_SECRET] ?? assert.fail("no token");
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;

const FILL_SECRET: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Access code" },
    value: { secretName: DATABASE_SECRET },
};
const READ_CART_ONCE: JsonRecord = {
    type: "evaluate",
    script: "readCart",
    arguments: { currency: "eur" },
};
const COUNT_ORDERS_ONCE: JsonRecord = {
    type: "database",
    command: "countOrders",
    arguments: { email: "ada@example.com" },
};
const SCRIPT_STEP = 2;
const COMMAND_STEP = 1;

const FORMS: readonly {
    readonly name: string;
    readonly written: (secret: string) => string;
}[] = [
    { name: "as it is", written: (secret) => secret },
    { name: "in base64", written: (secret) => echoForms(secret).base64 },
    { name: "URL-encoded", written: (secret) => echoForms(secret).uri },
];

const everythingKept = (result: RunResult, events: readonly LoggedEvent[]): string =>
    `${JSON.stringify(result)}\n${JSON.stringify(events)}`;

const stepOf = (result: RunResult, index: number): StepResult =>
    result.steps[index] ?? assert.fail(JSON.stringify(result.steps));

// The backend check's read, answered with the given body.
const readAnswering = (body: unknown) =>
    runWithCalls(
        callPlanOf([
            expectBackend("getOrder", { orderId: ORDER_ID }, "status", {
                kind: "equals",
                value: "paid",
            }),
        ]),
        {
            route: shopWith((request) =>
                requestLine(request) === READ_ORDER ? jsonReply(200, body) : undefined,
            ),
        },
    );

const scriptGiving = async (text: string) => {
    const { result, events } = await runOnFakeSession(
        unsafePlan([OPEN_CART, FILL_SECRET, READ_CART_ONCE]),
        { session: fakeSessionOnOrders({ runScript: () => Promise.resolve(success(text)) }) },
    );
    return { step: stepOf(result, SCRIPT_STEP), kept: everythingKept(result, events.read()) };
};

const commandPrinting = async (text: string) => {
    const { result, events } = await runOnFakeSession(unsafePlan([OPEN_CART, COUNT_ORDERS_ONCE]), {
        commandRoute: () => ({ stdout: text }),
    });
    return { step: stepOf(result, COMMAND_STEP), kept: everythingKept(result, events.read()) };
};

describe("Using a run that records a service's response", () => {
    for (const { name, written } of FORMS) {
        describe(`given a response holding the run's secret ${name}`, () => {
            describe("when the run keeps its record", () => {
                test("then it should keep the status and no hash of the body", async () => {
                    const body = { status: "paid", echo: { token: written(TOKEN) } };
                    const ran = await readAnswering(body);
                    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                    assert.equal(ran.result.steps[0]?.serviceCall?.status, 200);
                    assert.equal(ran.result.steps[0].serviceCall.responseSha256, null);
                    assert.equal(ran.everything.includes(sha256(JSON.stringify(body))), false);
                });
            });
        });
    }

    describe("given a response holding no secret", () => {
        describe("when the run keeps its record", () => {
            test("then it should keep the body's exact hash", async () => {
                const body = { status: "paid", total: 42 };
                const ran = await readAnswering(body);
                assert.equal(
                    ran.result.steps[0]?.serviceCall?.responseSha256,
                    sha256(JSON.stringify(body)),
                );
            });
        });
    });
});

describe("Using a run that records a page script's result", () => {
    for (const { name, written } of FORMS) {
        describe(`given a result holding the run's secret ${name}`, () => {
            describe("when the run keeps its record", () => {
                test("then it should keep no hash of the result", async () => {
                    const text = JSON.stringify({
                        count: 3,
                        total: written(DATABASE_PASSWORD),
                    });
                    const { step, kept } = await scriptGiving(text);
                    assert.equal(step.outcome, "passed", JSON.stringify(step));
                    assert.equal(step.pageScript?.resultSha256, null);
                    assert.equal(kept.includes(sha256(text)), false);
                });
            });
        });
    }

    describe("given a result holding no secret", () => {
        describe("when the run keeps its record", () => {
            test("then it should keep the result's exact hash", async () => {
                const text = JSON.stringify({ count: 3, total: "42.00" });
                const { step } = await scriptGiving(text);
                assert.equal(step.pageScript?.resultSha256, sha256(text));
            });
        });
    });
});

describe("Using a run that records a database command's output", () => {
    for (const { name, written } of FORMS) {
        describe(`given output holding the run's secret ${name}`, () => {
            describe("when the run keeps its record", () => {
                test("then it should keep no hash of the output", async () => {
                    const text = JSON.stringify({ count: "3", note: written(DATABASE_PASSWORD) });
                    const { step, kept } = await commandPrinting(text);
                    assert.equal(step.outcome, "passed", JSON.stringify(step));
                    assert.equal(step.databaseCommand?.outputSha256, null);
                    assert.equal(kept.includes(sha256(text)), false);
                });
            });
        });
    }

    describe("given output holding no secret", () => {
        describe("when the run keeps its record", () => {
            test("then it should keep the output's exact hash", async () => {
                const text = JSON.stringify({ count: "3" });
                const { step } = await commandPrinting(text);
                assert.equal(step.databaseCommand?.outputSha256, sha256(text));
            });
        });
    });
});
