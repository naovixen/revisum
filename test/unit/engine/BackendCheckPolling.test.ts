// A backend check repeats its read only while the service answers with a status its declaration
// lists as success and the check has not passed. A call that failed is not sent again, so an outage
// is reported at once instead of being waited out, or hidden by a later answer. No answer means the
// check learned nothing about the product, so the run ends Errored; any answer it could judge, Failed.
//
// The failing replies below are followed by a matching field, so a read sent again would pass the
// check and a test could not mistake a retry for a stop.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ServiceRequest } from "@revisum/engine";
import {
    ORDER_ID,
    SHOP_SERVICE,
    TOKEN_SECRET,
    callPlanOf,
    callProjectFile,
    emptyReply,
    expectBackend,
    failedReply,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    stepLines,
    textReply,
    type JsonRecord,
    type Reply,
    type Route,
} from "./service-call-examples.ts";

const BACKEND_CHECK_TIMEOUT = 2000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const ORDER_PAID = jsonReply(200, { status: "paid", total: 42 });
const ORDER_PENDING = jsonReply(200, { status: "pending", total: 42 });
const ORDER_STATUS_PAID = expectBackend("getOrder", { orderId: ORDER_ID }, "status", {
    kind: "equals",
    value: "paid",
});
const CHECK_PLAN = callPlanOf([ORDER_STATUS_PAID]);
const SHORT_CHECKS = callProjectFile(
    {},
    { backendCheckTimeoutMilliseconds: BACKEND_CHECK_TIMEOUT },
);

// The order, read by a service whose background job counts 404 as "not there yet".
const GET_ORDER_DECLARING_NOT_FOUND: JsonRecord = {
    service: SHOP_SERVICE,
    method: "GET",
    path: "/api/orders/{orderId}",
    headers: { authorization: { secretName: TOKEN_SECRET, scheme: "bearer" } },
    parameters: { orderId: { kind: "identifier" } },
    effect: "read",
    successStatuses: [200, 404],
    fields: { status: "/status", total: "/total" },
};
const NOT_FOUND_DECLARED = callProjectFile(
    { getOrder: GET_ORDER_DECLARING_NOT_FOUND },
    { backendCheckTimeoutMilliseconds: BACKEND_CHECK_TIMEOUT },
);

const readsOf = (requests: readonly ServiceRequest[]): readonly ServiceRequest[] =>
    requests.filter((request) => requestLine(request) === READ_ORDER);

// The shop, answering the order's reads with `replies` in turn and with `afterwards` from then on.
const readsAnswering = (replies: readonly Reply[], afterwards: Reply = ORDER_PAID): Route =>
    shopWith((request, earlier) =>
        requestLine(request) === READ_ORDER
            ? (replies[readsOf(earlier).length] ?? afterwards)
            : undefined,
    );

type FailedRead = {
    readonly name: string;
    readonly reply: Reply;
    readonly code: string;
    readonly status: number | null;
    readonly verdict: "Failed" | "Errored";
};

const FAILED_READS: readonly FailedRead[] = [
    {
        name: "the service cannot be reached",
        reply: failedReply("service-unreachable"),
        code: "service-unreachable",
        status: null,
        verdict: "Errored",
    },
    {
        name: "the read times out",
        reply: failedReply("call-timeout"),
        code: "call-timeout",
        status: null,
        verdict: "Errored",
    },
    {
        name: "the service answers a status its declaration does not list as success",
        reply: jsonReply(500, { error: "database down" }),
        code: "unexpected-status",
        status: 500,
        verdict: "Failed",
    },
    {
        name: "egress control refuses the read",
        reply: failedReply("egress-blocked"),
        code: "egress-blocked",
        status: null,
        verdict: "Failed",
    },
    {
        name: "the caller stops reading a response over its cap",
        reply: failedReply("response-too-large"),
        code: "response-too-large",
        status: null,
        verdict: "Failed",
    },
    {
        name: "a response over its cap reaches the run",
        reply: jsonReply(200, { padding: "x".repeat(DEFAULT_MAXIMUM_RESPONSE_BYTES) }),
        code: "response-too-large",
        status: null,
        verdict: "Failed",
    },
];

// What a read may get while the job runs: a JSON error, or the page most servers answer 404 with.
const NOT_FOUND_ANSWERS: readonly {
    readonly name: string;
    readonly reply: Reply;
    readonly codeAtTimeout: string;
}[] = [
    {
        name: "a JSON 404 without the field",
        reply: jsonReply(404, { error: "no such order yet" }),
        codeAtTimeout: "field-missing",
    },
    {
        name: "an HTML 404",
        reply: textReply(404, "text/html", "<html><body>Not found</body></html>"),
        codeAtTimeout: "response-not-json",
    },
    {
        name: "an empty 404",
        reply: emptyReply(404),
        codeAtTimeout: "response-not-json",
    },
];

describe("Using the backend check", () => {
    describe("given a read that fails as a call the first time it is sent", () => {
        for (const failed of FAILED_READS) {
            describe(`and ${failed.name}, though a later read would match`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should send the read exactly once", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([failed.reply]),
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                    });

                    test(`then it should fail the step with ${failed.code} and end the run ${failed.verdict}`, async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([failed.reply]),
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            `expectBackend failed ${failed.code}`,
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, failed.verdict);
                    });

                    test("then it should spend no time waiting", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([failed.reply]),
                        });
                        assert.equal(ran.clock.elapsed(), 0);
                    });

                    test("then it should record one attempt and the status it got", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([failed.reply]),
                        });
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 1, JSON.stringify(record));
                        assert.equal(record?.status, failed.status, JSON.stringify(record));
                    });
                });
            });
        }
    });

    describe("given a read that answered but has not passed the check", () => {
        for (const failed of FAILED_READS) {
            describe(`and on the second poll ${failed.name}, though a later read would match`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should stop polling there, having sent two reads in all", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([ORDER_PENDING, failed.reply]),
                            projectFile: SHORT_CHECKS,
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER, READ_ORDER]);
                        assert.equal(ran.result.steps[0]?.serviceCall?.attempts, 2);
                    });

                    test(`then it should fail the step with ${failed.code} and end the run ${failed.verdict}`, async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([ORDER_PENDING, failed.reply]),
                            projectFile: SHORT_CHECKS,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            `expectBackend failed ${failed.code}`,
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, failed.verdict);
                    });
                });
            });

            describe(`and from the second poll on ${failed.name}`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should not wait out the rest of the check timeout", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([ORDER_PENDING], failed.reply),
                            projectFile: SHORT_CHECKS,
                        });
                        assert.ok(
                            ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT,
                            `the check waited ${ran.clock.elapsed()} ms`,
                        );
                    });
                });
            });
        }
    });

    describe("given a read whose declaration lists 404 as success, for a job that takes time", () => {
        for (const notFound of NOT_FOUND_ANSWERS) {
            describe(`and the service answers ${notFound.name} until the job finishes`, () => {
                describe("when the job finishes on the third poll", () => {
                    test("then it should keep polling and pass, having sent three reads", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([notFound.reply, notFound.reply]),
                            projectFile: NOT_FOUND_DECLARED,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend passed",
                            "expect passed",
                        ]);
                        assert.equal(ran.result.state, "Passed");
                        assert.equal(readsOf(ran.requests).length, 3);
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 3, JSON.stringify(record));
                        assert.equal(record?.status, 200, JSON.stringify(record));
                    });
                });

                describe("when the job never finishes", () => {
                    test(`then it should keep polling until the check timeout runs out, then fail with ${notFound.codeAtTimeout}`, async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([], notFound.reply),
                            projectFile: NOT_FOUND_DECLARED,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            `expectBackend failed ${notFound.codeAtTimeout}`,
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                        assert.ok(readsOf(ran.requests).length > 1, "the read was not polled");
                        assert.ok(
                            ran.clock.elapsed() >= BACKEND_CHECK_TIMEOUT,
                            `the check gave up after ${ran.clock.elapsed()} ms`,
                        );
                    });
                });
            });
        }
    });

    describe("given a read whose declaration does not list 404 as success", () => {
        describe("and the service answers 404 until the job finishes", () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with unexpected-status on the first read", async () => {
                    const notFound = jsonReply(404, { error: "no such order yet" });
                    const ran = await runWithCalls(CHECK_PLAN, {
                        route: readsAnswering([notFound, notFound]),
                        projectFile: SHORT_CHECKS,
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "expectBackend failed unexpected-status",
                        "expect skipped",
                    ]);
                    assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                });
            });
        });
    });
});
