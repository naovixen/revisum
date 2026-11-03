// A declaration's pendingStatuses list the statuses that mean "not ready yet". A backend check keeps
// polling on those statuses under its check timeout, whatever the answer's body holds. Stopping on a
// failed call is unchanged: nothing is sent after one.
//
// Which code the step reports when the timeout runs out on a pending status is left open, so those
// tests read its outcome and the run's verdict, not its code.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunResult, ServiceRequest } from "@revisum/engine";
import {
    CALLS,
    ORDER_ID,
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
const ORDER_NOT_PAID = jsonReply(200, { status: "open", total: 42 });
const ORDER_WITHOUT_STATUS = jsonReply(200, { total: 42 });

const checkOf = (assertion: JsonRecord): JsonRecord =>
    expectBackend("getOrder", { orderId: ORDER_ID }, "status", assertion);
const STATUS_PAID_PLAN = callPlanOf([checkOf({ kind: "equals", value: "paid" })]);

const getOrderWith = (changes: JsonRecord): JsonRecord => ({
    ...(structuredClone(CALLS["getOrder"]) as JsonRecord),
    ...changes,
});
const projectWith = (changes: JsonRecord): JsonRecord =>
    callProjectFile(
        { getOrder: getOrderWith(changes) },
        { backendCheckTimeoutMilliseconds: BACKEND_CHECK_TIMEOUT },
    );
const PENDING_DECLARED = projectWith({ successStatuses: [200], pendingStatuses: [202, 404] });

const readsOf = (requests: readonly ServiceRequest[]): readonly ServiceRequest[] =>
    requests.filter((request) => requestLine(request) === READ_ORDER);

// The shop, answering the order's reads with `replies` in turn and with `afterwards` from then on.
const readsAnswering = (replies: readonly Reply[], afterwards: Reply = ORDER_PAID): Route =>
    shopWith((request, earlier) =>
        requestLine(request) === READ_ORDER
            ? (replies[readsOf(earlier).length] ?? afterwards)
            : undefined,
    );

// Reads that stay pending far past what the check timeout allows, then `afterwards`. A check that
// ignored its timeout then ends on that answer and fails an assertion, instead of never returning.
const MORE_READS_THAN_THE_TIMEOUT_ALLOWS = 1000;
const pendingPastTheTimeout = (reply: Reply, afterwards: Reply = ORDER_PAID): Route =>
    readsAnswering(Array<Reply>(MORE_READS_THAN_THE_TIMEOUT_ALLOWS).fill(reply), afterwards);

const stepOutcomes = (result: RunResult): readonly string[] =>
    result.steps.map((step) => `${step.type} ${step.outcome}`);

const PENDING_ANSWERS: readonly {
    readonly name: string;
    readonly reply: Reply;
    readonly status: number;
}[] = [
    {
        name: "a JSON 404 without the field",
        reply: jsonReply(404, { error: "no such order yet" }),
        status: 404,
    },
    {
        name: "an HTML 404",
        reply: textReply(404, "text/html", "<html><body>Not found</body></html>"),
        status: 404,
    },
    { name: "an empty 404", reply: emptyReply(404), status: 404 },
    { name: "a JSON 202", reply: jsonReply(202, { progress: "queued" }), status: 202 },
];

// Bodies that would pass the check if a pending answer were judged by its field.
const PENDING_BODIES_THAT_WOULD_PASS: readonly {
    readonly name: string;
    readonly assertion: JsonRecord;
    readonly pending: Reply;
    readonly finished: Reply;
}[] = [
    {
        name: "equals, with a pending body holding the expected value",
        assertion: { kind: "equals", value: "paid" },
        pending: jsonReply(404, { status: "paid" }),
        finished: ORDER_PAID,
    },
    {
        name: "contains, with a pending body holding the expected text",
        assertion: { kind: "contains", value: "ai" },
        pending: jsonReply(202, { status: "paid" }),
        finished: ORDER_PAID,
    },
    {
        name: "present, with a pending body holding the field",
        assertion: { kind: "present" },
        pending: jsonReply(404, { status: "unknown" }),
        finished: ORDER_PAID,
    },
    {
        name: "absent, with a pending body lacking the field",
        assertion: { kind: "absent" },
        pending: jsonReply(404, { error: "no such order yet" }),
        finished: ORDER_WITHOUT_STATUS,
    },
];

// Each is followed by pending answers and then a matching field, so a read sent after it would show.
const FAILED_READS: readonly {
    readonly name: string;
    readonly reply: Reply;
    readonly code: string;
    readonly status: number | null;
    readonly verdict: "Failed" | "Errored";
}[] = [
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
        name: "the service answers a status neither list names",
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
        name: "a pending status arrives with a body over the cap",
        reply: jsonReply(404, { padding: "x".repeat(DEFAULT_MAXIMUM_RESPONSE_BYTES) }),
        code: "response-too-large",
        status: null,
        verdict: "Failed",
    },
];

const STILL_PENDING = jsonReply(404, { error: "no such order yet" });

describe("Using the backend check", () => {
    describe("given a read whose declaration lists 202 and 404 as pending statuses", () => {
        for (const pending of PENDING_ANSWERS) {
            describe(`and the service answers ${pending.name} until the job finishes`, () => {
                describe("when the job finishes on the third poll", () => {
                    test("then it should keep polling and pass, having sent three reads", async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([pending.reply, pending.reply]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend passed",
                            "expect passed",
                        ]);
                        assert.equal(ran.result.state, "Passed");
                        assert.equal(readsOf(ran.requests).length, 3);
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 3, JSON.stringify(record));
                        assert.equal(record.status, 200, JSON.stringify(record));
                    });

                    test("then it should finish before the check timeout, having waited between reads", async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([pending.reply, pending.reply]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.ok(ran.clock.elapsed() > 0, "the reads were not spaced out");
                        assert.ok(
                            ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT,
                            `the check waited ${ran.clock.elapsed()} ms`,
                        );
                    });
                });

                describe("when the job has not finished by the check timeout", () => {
                    test("then it should keep polling until the timeout, then fail the step and end the run Failed", async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: pendingPastTheTimeout(pending.reply),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(stepOutcomes(ran.result), [
                            "expectBackend failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                        assert.ok(readsOf(ran.requests).length > 1, "the read was not polled");
                        assert.ok(
                            ran.clock.elapsed() >= BACKEND_CHECK_TIMEOUT,
                            `the check gave up after ${ran.clock.elapsed()} ms`,
                        );
                        assert.ok(
                            ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT * 2,
                            `the check kept polling for ${ran.clock.elapsed()} ms`,
                        );
                    });

                    test(`then it should record every read and the last status, ${pending.status}`, async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: pendingPastTheTimeout(pending.reply),
                            projectFile: PENDING_DECLARED,
                        });
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(
                            record?.attempts,
                            readsOf(ran.requests).length,
                            JSON.stringify(record),
                        );
                        assert.equal(record.status, pending.status, JSON.stringify(record));
                    });
                });
            });
        }

        for (const body of PENDING_BODIES_THAT_WOULD_PASS) {
            describe(`and the check is ${body.name}`, () => {
                describe("when the job finishes on the third poll", () => {
                    test("then it should not pass on a pending answer, and pass on the third read", async () => {
                        const ran = await runWithCalls(callPlanOf([checkOf(body.assertion)]), {
                            route: readsAnswering([body.pending, body.pending], body.finished),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                        assert.equal(readsOf(ran.requests).length, 3);
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 3, JSON.stringify(record));
                        assert.equal(record.status, 200, JSON.stringify(record));
                    });
                });

                describe("when the job never finishes", () => {
                    test("then it should fail the step at the check timeout and end the run Failed", async () => {
                        const ran = await runWithCalls(callPlanOf([checkOf(body.assertion)]), {
                            route: pendingPastTheTimeout(body.pending, body.finished),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(stepOutcomes(ran.result), [
                            "expectBackend failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                        assert.ok(
                            ran.clock.elapsed() >= BACKEND_CHECK_TIMEOUT,
                            `the check gave up after ${ran.clock.elapsed()} ms`,
                        );
                    });
                });
            });
        }

        describe("and the service moves between pending answers and a field that does not match yet", () => {
            describe("when the field matches on the fourth poll", () => {
                test("then it should keep polling through both and pass, having sent four reads", async () => {
                    const ran = await runWithCalls(STATUS_PAID_PLAN, {
                        route: readsAnswering([STILL_PENDING, ORDER_NOT_PAID, STILL_PENDING]),
                        projectFile: PENDING_DECLARED,
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "expectBackend passed",
                        "expect passed",
                    ]);
                    assert.equal(readsOf(ran.requests).length, 4);
                    assert.equal(ran.result.steps[0]?.serviceCall?.attempts, 4);
                });
            });
        });

        describe("and the service leaves pending but the field never matches", () => {
            describe("when the check timeout runs out", () => {
                test("then it should fail the step with assertion-failed and end the run Failed", async () => {
                    const ran = await runWithCalls(STATUS_PAID_PLAN, {
                        route: readsAnswering([STILL_PENDING], ORDER_NOT_PAID),
                        projectFile: PENDING_DECLARED,
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "expectBackend failed assertion-failed",
                        "expect skipped",
                    ]);
                    assert.equal(ran.result.state, "Failed");
                });
            });
        });

        for (const failed of FAILED_READS) {
            describe(`and on the second poll ${failed.name}, with pending answers and a match still to come`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should stop polling there, having sent two reads in all", async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([STILL_PENDING, failed.reply, STILL_PENDING]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER, READ_ORDER]);
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 2, JSON.stringify(record));
                        assert.equal(record.status, failed.status, JSON.stringify(record));
                    });

                    test(`then it should fail the step with ${failed.code} and end the run ${failed.verdict}`, async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([STILL_PENDING, failed.reply, STILL_PENDING]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            `expectBackend failed ${failed.code}`,
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, failed.verdict);
                    });

                    test("then it should not wait out the rest of the check timeout", async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([STILL_PENDING, failed.reply, STILL_PENDING]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.ok(
                            ran.clock.elapsed() < BACKEND_CHECK_TIMEOUT,
                            `the check waited ${ran.clock.elapsed()} ms`,
                        );
                    });
                });
            });

            describe(`and on the first read ${failed.name}, with pending answers and a match still to come`, () => {
                describe("when the run reaches the check", () => {
                    test(`then it should send one read, fail the step with ${failed.code} and end the run ${failed.verdict}`, async () => {
                        const ran = await runWithCalls(STATUS_PAID_PLAN, {
                            route: readsAnswering([failed.reply, STILL_PENDING]),
                            projectFile: PENDING_DECLARED,
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                        assert.deepEqual(stepLines(ran.result), [
                            `expectBackend failed ${failed.code}`,
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, failed.verdict);
                        assert.equal(ran.clock.elapsed(), 0);
                    });
                });
            });
        }

        describe("and on the second poll the service answers 503, which neither list names, with a match still to come", () => {
            describe("when the run reaches the check", () => {
                test("then it should stop there, having sent two reads, and end the run Errored", async () => {
                    const ran = await runWithCalls(STATUS_PAID_PLAN, {
                        route: readsAnswering([STILL_PENDING, jsonReply(503, {})]),
                        projectFile: PENDING_DECLARED,
                    });
                    assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER, READ_ORDER]);
                    assert.deepEqual(stepOutcomes(ran.result), [
                        "expectBackend failed",
                        "expect skipped",
                    ]);
                    assert.equal(ran.result.state, "Errored");
                });
            });
        });
    });
});
