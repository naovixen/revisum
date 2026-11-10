// A step's record of a service call holds the status it got and the response's sha256, whatever the
// status was: a call that answered 500 is exactly the one a person needs to look at.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256 } from "@revisum/engine";
import {
    CREATE_ORDER,
    ORDER_ID,
    callPlanOf,
    expectBackend,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    type Reply,
} from "./examples/ShopService.ts";
import { ServiceCallErrorCode } from "@revisum/contracts";

const SERVER_ERROR_BODY = { error: "database down" };
const bodyHash = (body: unknown): string => sha256(new TextEncoder().encode(JSON.stringify(body)));

const creatingAnOrderAnswers = (reply: Reply) =>
    shopWith((request) => (requestLine(request) === "POST /api/orders" ? reply : undefined));
const readingTheOrderAnswers = (reply: Reply) =>
    shopWith((request) =>
        requestLine(request) === `GET /api/orders/${ORDER_ID}` ? reply : undefined,
    );

const ORDER_STATUS_PAID = expectBackend("getOrder", { orderId: ORDER_ID }, "status", {
    kind: "equals",
    value: "paid",
});

describe("Using the run", () => {
    describe("given a call step", () => {
        describe("and the service answers a status its declaration does not list as success", () => {
            describe("when the run records the call", () => {
                test("then it should hold the status and the response's sha256", async () => {
                    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), {
                        route: creatingAnOrderAnswers(jsonReply(500, SERVER_ERROR_BODY)),
                    });
                    const step = ran.result.steps[0];
                    assert.equal(step?.code, "unexpected-status", JSON.stringify(step));
                    assert.equal(step.serviceCall?.status, 500, JSON.stringify(step));
                    assert.equal(
                        step.serviceCall.responseSha256,
                        bodyHash(SERVER_ERROR_BODY),
                        JSON.stringify(step),
                    );
                });

                test("then it should keep the response body itself out of the result", async () => {
                    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), {
                        route: creatingAnOrderAnswers(jsonReply(500, SERVER_ERROR_BODY)),
                    });
                    assert.equal(ran.everything.includes(SERVER_ERROR_BODY.error), false);
                });
            });
        });

        describe("and the service answers a status its declaration lists as success", () => {
            describe("when the run records the call", () => {
                test("then it should hold the status and the response's sha256", async () => {
                    const body = { id: ORDER_ID, status: "pending" };
                    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), {
                        route: creatingAnOrderAnswers(jsonReply(201, body)),
                    });
                    const step = ran.result.steps[0];
                    assert.equal(step?.outcome, "passed", JSON.stringify(step));
                    assert.equal(step.serviceCall?.status, 201);
                    assert.equal(step.serviceCall.responseSha256, bodyHash(body));
                });
            });
        });

        describe("and the service cannot be reached", () => {
            describe("when the run records the call", () => {
                test("then it should hold no status and no sha256", async () => {
                    const ran = await runWithCalls(callPlanOf([CREATE_ORDER]), {
                        route: creatingAnOrderAnswers({
                            ok: false,
                            error: ServiceCallErrorCode.ServiceUnreachable,
                        }),
                    });
                    const step = ran.result.steps[0];
                    assert.equal(step?.code, "service-unreachable");
                    assert.equal(step.serviceCall?.status, null);
                    assert.equal(step.serviceCall.responseSha256, null);
                });
            });
        });
    });

    describe("given a backend check", () => {
        describe("and the service keeps answering a status its declaration does not list as success", () => {
            describe("when the run records the check", () => {
                test("then it should hold the status and the response's sha256", async () => {
                    const ran = await runWithCalls(callPlanOf([ORDER_STATUS_PAID]), {
                        route: readingTheOrderAnswers(jsonReply(500, SERVER_ERROR_BODY)),
                    });
                    const step = ran.result.steps[0];
                    assert.equal(step?.code, "unexpected-status", JSON.stringify(step));
                    assert.equal(step.serviceCall?.status, 500, JSON.stringify(step));
                    assert.equal(
                        step.serviceCall.responseSha256,
                        bodyHash(SERVER_ERROR_BODY),
                        JSON.stringify(step),
                    );
                });
            });
        });
    });
});
