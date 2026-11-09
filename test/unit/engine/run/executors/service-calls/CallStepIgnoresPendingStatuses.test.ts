// Only a backend check reads a declaration's pendingStatuses. A plain call to the same declaration
// ignores them, so a status listed only there is an undeclared status for the call, and a call can't
// pass on an answer that means "not ready yet".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    CALLS,
    ORDER_ID,
    call,
    callPlanOf,
    callProjectFile,
    cleanupRecords,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    stepLines,
    withCleanup,
    type JsonRecord,
    type Reply,
    type Route,
} from "./examples/ShopService.ts";

const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const READ_CALL = call("getOrder", { orderId: ORDER_ID });
const READ_PLAN = callPlanOf([READ_CALL]);
const ORDER_PAID = jsonReply(200, { status: "paid", total: 42 });
const NOT_FOUND = jsonReply(404, { error: "no such order yet" });

const projectWith = (changes: JsonRecord): JsonRecord =>
    callProjectFile({
        getOrder: { ...(structuredClone(CALLS["getOrder"]) as JsonRecord), ...changes },
    });
const NOT_FOUND_PENDING = projectWith({ successStatuses: [200], pendingStatuses: [404] });
const NOT_FOUND_AS_SUCCESS = projectWith({ successStatuses: [200, 404] });

// The shop, answering every read of the order with `reply`.
const readsAnswering = (reply: Reply): Route =>
    shopWith((request) => (requestLine(request) === READ_ORDER ? reply : undefined));

describe("Using the call step", () => {
    describe("given a declaration that lists 404 only as a pending status", () => {
        describe("and the service answers 404", () => {
            describe("when the plan calls it", () => {
                test("then it should fail the step with unexpected-status and end the run Errored", async () => {
                    const ran = await runWithCalls(READ_PLAN, {
                        route: readsAnswering(NOT_FOUND),
                        projectFile: NOT_FOUND_PENDING,
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "call failed unexpected-status",
                        "expect skipped",
                    ]);
                    assert.equal(ran.result.state, "Errored");
                });

                test("then it should send the call exactly once and record the status 404", async () => {
                    const ran = await runWithCalls(READ_PLAN, {
                        route: readsAnswering(NOT_FOUND),
                        projectFile: NOT_FOUND_PENDING,
                    });
                    assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                    assert.equal(ran.clock.elapsed(), 0);
                    const record = ran.result.steps[0]?.serviceCall;
                    assert.equal(record?.attempts, 1, JSON.stringify(record));
                    assert.equal(record.status, 404, JSON.stringify(record));
                });
            });

            describe("when the plan's cleanup calls it", () => {
                test("then it should record the cleanup as failed and leave the verdict Passed", async () => {
                    const ran = await runWithCalls(withCleanup(callPlanOf([]), [READ_CALL]), {
                        route: readsAnswering(NOT_FOUND),
                        projectFile: NOT_FOUND_PENDING,
                    });
                    assert.deepEqual(cleanupRecords(ran.result), [
                        { outcome: "failed", code: "cleanup-failed" },
                    ]);
                    assert.equal(ran.result.state, "Passed");
                });
            });
        });

        describe("and the service answers 200", () => {
            describe("when the plan calls it", () => {
                test("then it should pass the step, as 200 is a success status", async () => {
                    const ran = await runWithCalls(READ_PLAN, {
                        route: readsAnswering(ORDER_PAID),
                        projectFile: NOT_FOUND_PENDING,
                    });
                    assert.deepEqual(stepLines(ran.result), ["call passed", "expect passed"]);
                    assert.equal(ran.result.state, "Passed");
                });
            });
        });
    });

    describe("given a declaration that lists 404 as a success status", () => {
        describe("and the service answers 404", () => {
            describe("when the plan calls it", () => {
                test("then it should pass the step, as a call judges by its success statuses", async () => {
                    const ran = await runWithCalls(READ_PLAN, {
                        route: readsAnswering(NOT_FOUND),
                        projectFile: NOT_FOUND_AS_SUCCESS,
                    });
                    assert.deepEqual(stepLines(ran.result), ["call passed", "expect passed"]);
                });
            });
        });
    });
});
