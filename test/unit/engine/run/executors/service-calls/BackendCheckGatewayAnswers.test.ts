// A 502, 503 or 504 says a gateway could not get an answer from the service, so a backend check that
// gets one learned nothing about the product: the run could not test, and ends Errored. Any other
// status the declaration does not list is an answer from the product, and ends Failed.
//
// Which code the step reports for a gateway answer is left open, so these tests read its outcome and
// the run's verdict, not its code. Every failing reply is followed by a matching field, so a read
// sent again would pass the check and a test could not mistake a retry for a stop.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunResult, ServiceRequest } from "@revisum/engine";
import {
    ORDER_ID,
    callPlanOf,
    callProjectFile,
    emptyReply,
    expectBackend,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    stepLines,
    textReply,
    type Reply,
    type Route,
} from "./examples/ShopService.ts";

const BACKEND_CHECK_TIMEOUT = 2000;
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const ORDER_PAID = jsonReply(200, { status: "paid", total: 42 });
const ORDER_PENDING = jsonReply(200, { status: "pending", total: 42 });
const CHECK_PLAN = callPlanOf([
    expectBackend("getOrder", { orderId: ORDER_ID }, "status", { kind: "equals", value: "paid" }),
]);
const SHORT_CHECKS = callProjectFile(
    {},
    { backendCheckTimeoutMilliseconds: BACKEND_CHECK_TIMEOUT },
);

const readsOf = (requests: readonly ServiceRequest[]): readonly ServiceRequest[] =>
    requests.filter((request) => requestLine(request) === READ_ORDER);

// The shop, answering the order's reads with `replies` in turn and with a paid order from then on.
const readsAnswering = (replies: readonly Reply[]): Route =>
    shopWith((request, earlier) =>
        requestLine(request) === READ_ORDER
            ? (replies[readsOf(earlier).length] ?? ORDER_PAID)
            : undefined,
    );

const stepOutcomes = (result: RunResult): readonly string[] =>
    result.steps.map((step) => `${step.type} ${step.outcome}`);

const GATEWAY_STATUSES = [502, 503, 504] as const;

// What a gateway may send: its own page, a JSON error, nothing, or a body that looks like success.
const gatewayAnswers = (
    status: number,
): readonly { readonly name: string; readonly reply: Reply }[] => [
    {
        name: "an HTML page",
        reply: textReply(status, "text/html", "<html><body>Gateway error</body></html>"),
    },
    { name: "a JSON error", reply: jsonReply(status, { error: "upstream unavailable" }) },
    { name: "an empty body", reply: emptyReply(status) },
    { name: "a body whose field would match", reply: jsonReply(status, { status: "paid" }) },
];

const OTHER_UNDECLARED_STATUSES = [302, 400, 404, 409, 429, 500, 501, 505, 599] as const;

describe("Using the backend check", () => {
    for (const status of GATEWAY_STATUSES) {
        describe(`given a read whose declaration does not list ${status}`, () => {
            for (const answer of gatewayAnswers(status)) {
                describe(`and the first read gets ${status} with ${answer.name}, though a later read would match`, () => {
                    describe("when the run reaches the check", () => {
                        test("then it should fail the step and end the run Errored", async () => {
                            const ran = await runWithCalls(CHECK_PLAN, {
                                route: readsAnswering([answer.reply]),
                            });
                            assert.deepEqual(stepOutcomes(ran.result), [
                                "expectBackend failed",
                                "expect skipped",
                            ]);
                            assert.equal(ran.result.state, "Errored");
                        });

                        test("then it should send the read exactly once and spend no time waiting", async () => {
                            const ran = await runWithCalls(CHECK_PLAN, {
                                route: readsAnswering([answer.reply]),
                            });
                            assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                            assert.equal(ran.clock.elapsed(), 0);
                        });

                        test(`then it should record one attempt and the status ${status}`, async () => {
                            const ran = await runWithCalls(CHECK_PLAN, {
                                route: readsAnswering([answer.reply]),
                            });
                            const record = ran.result.steps[0]?.serviceCall;
                            assert.equal(record?.attempts, 1, JSON.stringify(record));
                            assert.equal(record.status, status, JSON.stringify(record));
                        });
                    });
                });
            }

            describe(`and the read has not passed the check when the second poll gets ${status}, though a later read would match`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should stop there, having sent two reads, and end the run Errored", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([ORDER_PENDING, jsonReply(status, {})]),
                            projectFile: SHORT_CHECKS,
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER, READ_ORDER]);
                        assert.deepEqual(stepOutcomes(ran.result), [
                            "expectBackend failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Errored");
                        assert.ok(
                            ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT,
                            `the check waited ${ran.clock.elapsed()} ms`,
                        );
                    });
                });
            });
        });
    }

    for (const status of OTHER_UNDECLARED_STATUSES) {
        describe(`given a read whose declaration does not list ${status}`, () => {
            describe(`and the first read gets ${status}, though a later read would match`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should fail the step with unexpected-status and end the run Failed", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([jsonReply(status, { error: "refused" })]),
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend failed unexpected-status",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                    });

                    test("then it should send the read exactly once", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([jsonReply(status, { error: "refused" })]),
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                    });
                });
            });
        });
    }
});
