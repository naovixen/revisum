// A 502, 503 or 504 the declaration does not list ends a backend check at once, as Errored. Declaring
// one wins over that rule: in successStatuses it is judged as a success, and in pendingStatuses it is
// polled. When the check timeout runs out on a pending status, the verdict follows the last status: a
// gateway status means the check could not test, so Errored, and any other means Failed.
//
// Which code the step reports for a gateway answer is left open, so those tests read its outcome and
// the run's verdict, not its code.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunResult, ServiceRequest } from "@revisum/engine";
import {
    CALLS,
    ORDER_ID,
    call,
    callPlanOf,
    callProjectFile,
    expectBackend,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    stepLines,
    type JsonRecord,
    type Reply,
    type Route,
} from "./service-call-examples.ts";

const BACKEND_CHECK_TIMEOUT = 2000;
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const ORDER_PAID = jsonReply(200, { status: "paid", total: 42 });
const ORDER_NOT_PAID = jsonReply(200, { status: "open", total: 42 });
const NOT_FOUND = jsonReply(404, { error: "no such order yet" });
const CHECK_PLAN = callPlanOf([
    expectBackend("getOrder", { orderId: ORDER_ID }, "status", { kind: "equals", value: "paid" }),
]);
const READ_PLAN = callPlanOf([call("getOrder", { orderId: ORDER_ID })]);

const projectWith = (changes: JsonRecord): JsonRecord =>
    callProjectFile(
        { getOrder: { ...(structuredClone(CALLS["getOrder"]) as JsonRecord), ...changes } },
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

// Reads that repeat far past what the check timeout allows, then a match. A check that ignored its
// timeout then passes and fails an assertion, instead of never returning.
const MORE_READS_THAN_THE_TIMEOUT_ALLOWS = 1000;
const repeatedPastTheTimeout = (earlier: readonly Reply[], reply: Reply): Route =>
    readsAnswering([...earlier, ...Array<Reply>(MORE_READS_THAN_THE_TIMEOUT_ALLOWS).fill(reply)]);

const stepOutcomes = (result: RunResult): readonly string[] =>
    result.steps.map((step) => `${step.type} ${step.outcome}`);

const GATEWAY_STATUSES = [502, 503, 504] as const;

describe("Using the backend check", () => {
    for (const status of GATEWAY_STATUSES) {
        const successDeclared = projectWith({ successStatuses: [200, status] });
        const pendingDeclared = projectWith({ successStatuses: [200], pendingStatuses: [status] });
        const gateway = jsonReply(status, { error: "upstream unavailable" });

        describe(`given a read whose declaration lists ${status} as a success status`, () => {
            describe(`and the service answers ${status} with the field that matches`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should pass on the first read and end the run Passed", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([jsonReply(status, { status: "paid" })]),
                            projectFile: successDeclared,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend passed",
                            "expect passed",
                        ]);
                        assert.equal(ran.result.state, "Passed");
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 1, JSON.stringify(record));
                        assert.equal(record?.status, status, JSON.stringify(record));
                    });
                });
            });

            describe(`and the service answers ${status} without the field that matches, until a later read matches`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should keep polling and pass, having sent three reads", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([
                                jsonReply(status, { status: "open" }),
                                jsonReply(status, { status: "open" }),
                            ]),
                            projectFile: successDeclared,
                        });
                        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                        assert.equal(readsOf(ran.requests).length, 3);
                    });
                });
            });

            describe(`and the service answers ${status} with a field that never matches`, () => {
                describe("when the check timeout runs out", () => {
                    test("then it should fail the step with assertion-failed and end the run Failed", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: repeatedPastTheTimeout(
                                [],
                                jsonReply(status, { status: "open" }),
                            ),
                            projectFile: successDeclared,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend failed assertion-failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                    });
                });
            });
        });

        describe(`given a read whose declaration lists ${status} as a pending status`, () => {
            describe(`and the service answers ${status} until the job finishes`, () => {
                describe("when the job finishes on the third poll", () => {
                    test("then it should keep polling and pass, having sent three reads", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([gateway, gateway]),
                            projectFile: pendingDeclared,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend passed",
                            "expect passed",
                        ]);
                        assert.equal(ran.result.state, "Passed");
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.attempts, 3, JSON.stringify(record));
                        assert.equal(record?.status, 200, JSON.stringify(record));
                    });
                });

                describe("when the job has not finished by the check timeout", () => {
                    test("then it should poll until the timeout, fail the step and end the run Errored", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: repeatedPastTheTimeout([], gateway),
                            projectFile: pendingDeclared,
                        });
                        assert.deepEqual(stepOutcomes(ran.result), [
                            "expectBackend failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Errored");
                        assert.ok(readsOf(ran.requests).length > 1, "the read was not polled");
                        assert.ok(
                            ran.clock.elapsed() >= BACKEND_CHECK_TIMEOUT,
                            `the check gave up after ${ran.clock.elapsed()} ms`,
                        );
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.status, status, JSON.stringify(record));
                    });
                });
            });

            describe(`and the service answers ${status} with a body whose field would match`, () => {
                describe("when the job finishes on the third poll", () => {
                    test("then it should not pass on a pending answer, and pass on the third read", async () => {
                        const looksPaid = jsonReply(status, { status: "paid" });
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: readsAnswering([looksPaid, looksPaid]),
                            projectFile: pendingDeclared,
                        });
                        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                        assert.equal(ran.result.steps[0]?.serviceCall?.attempts, 3);
                    });
                });
            });

            describe(`and the service answers ${status} first and 404 from then on`, () => {
                describe("when the check timeout runs out on the 404, also pending", () => {
                    test("then it should end the run Failed, following the last status", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: repeatedPastTheTimeout([gateway], NOT_FOUND),
                            projectFile: projectWith({ pendingStatuses: [status, 404] }),
                        });
                        assert.equal(ran.result.state, "Failed");
                        assert.equal(ran.result.steps[0]?.serviceCall?.status, 404);
                    });
                });
            });

            describe(`and the service answers 404 first and ${status} from then on`, () => {
                describe(`when the check timeout runs out on the ${status}`, () => {
                    test("then it should end the run Errored, following the last status", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: repeatedPastTheTimeout([NOT_FOUND], gateway),
                            projectFile: projectWith({ pendingStatuses: [status, 404] }),
                        });
                        assert.equal(ran.result.state, "Errored");
                        assert.equal(ran.result.steps[0]?.serviceCall?.status, status);
                    });
                });
            });

            describe(`and the service answers ${status} first and a field that never matches from then on`, () => {
                describe("when the check timeout runs out", () => {
                    test("then it should fail the step with assertion-failed and end the run Failed", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: repeatedPastTheTimeout([gateway], ORDER_NOT_PAID),
                            projectFile: pendingDeclared,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend failed assertion-failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Failed");
                    });
                });
            });
        });
    }

    describe("given a read whose declaration lists 503 but not 502 as a pending status", () => {
        describe("and the service answers 503 and then 502, with a match still to come", () => {
            describe("when the run reaches the check", () => {
                test("then it should stop on the undeclared 502, having sent two reads, and end the run Errored", async () => {
                    const ran = await runWithCalls(CHECK_PLAN, {
                        route: readsAnswering([jsonReply(503, {}), jsonReply(502, {})]),
                        projectFile: projectWith({ pendingStatuses: [503] }),
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

describe("Using the call step", () => {
    for (const status of GATEWAY_STATUSES) {
        const answered = jsonReply(status, { error: "upstream unavailable" });

        describe(`given a declaration that lists ${status} as a success status`, () => {
            describe(`and the service answers ${status}`, () => {
                describe("when the plan calls it", () => {
                    test("then it should pass the step, as declaring the status wins", async () => {
                        const ran = await runWithCalls(READ_PLAN, {
                            route: readsAnswering([answered]),
                            projectFile: projectWith({ successStatuses: [200, status] }),
                        });
                        assert.deepEqual(stepLines(ran.result), ["call passed", "expect passed"]);
                        assert.equal(ran.result.state, "Passed");
                    });
                });
            });
        });

        describe(`given a declaration that lists ${status} only as a pending status`, () => {
            describe(`and the service answers ${status}`, () => {
                describe("when the plan calls it", () => {
                    test("then it should fail the step on the one request and end the run Errored", async () => {
                        const ran = await runWithCalls(READ_PLAN, {
                            route: readsAnswering([answered]),
                            projectFile: projectWith({ pendingStatuses: [status] }),
                        });
                        assert.deepEqual(stepOutcomes(ran.result), [
                            "call failed",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Errored");
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                    });
                });
            });
        });
    }
});
