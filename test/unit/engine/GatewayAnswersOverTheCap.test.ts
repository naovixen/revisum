// A gateway's status says nothing about the product, however long its error page is. The caller reports
// the status of a body over the cap, with the body cut one byte past it, so a backend check that gets
// a 502, 503 or 504 that way could not test, as it could not with a short body. Every other status
// over the cap stays a failure of the product's response.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256 } from "@revisum/engine";
import {
    CALLS,
    ORDER_ID,
    callPlanOf,
    callProjectFile,
    expectBackend,
    jsonReply,
    requestLine,
    runWithCalls,
    shopWith,
    stepLines,
    textReply,
    type JsonRecord,
    type Reply,
} from "./service-call-examples.ts";

const CAP = 256;
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const CUT_BODY = "x".repeat(CAP + 1);
const AT_THE_CAP = "x".repeat(CAP);
const CHECK_PLAN = callPlanOf([
    expectBackend("getOrder", { orderId: ORDER_ID }, "status", { kind: "equals", value: "paid" }),
]);

const getOrderWith = (changes: JsonRecord): JsonRecord =>
    callProjectFile({
        getOrder: { ...(CALLS["getOrder"] as JsonRecord), maximumResponseBytes: CAP, ...changes },
    });
const CAPPED = getOrderWith({});

const answering = (reply: Reply) =>
    shopWith((request) => (requestLine(request) === READ_ORDER ? reply : undefined));

describe("Using the backend check", () => {
    for (const status of [502, 503, 504]) {
        describe(`given a read whose declaration does not list ${status}, capped at ${CAP} bytes`, () => {
            describe(`and the read gets ${status} with a body over the cap`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should fail with service-unreachable and end the run Errored", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: answering(textReply(status, "text/html", CUT_BODY)),
                            projectFile: CAPPED,
                        });
                        assert.deepEqual(stepLines(ran.result), [
                            "expectBackend failed service-unreachable",
                            "expect skipped",
                        ]);
                        assert.equal(ran.result.state, "Errored");
                    });

                    test("then it should send the read once and record its status without a hash", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: answering(textReply(status, "text/html", CUT_BODY)),
                            projectFile: CAPPED,
                        });
                        assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                        const record = ran.result.steps[0]?.serviceCall;
                        assert.equal(record?.status, status, JSON.stringify(record));
                        assert.equal(record.responseSha256, null);
                        assert.equal(record.attempts, 1);
                    });

                    test("then it should log no hash of the body cut short", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: answering(textReply(status, "text/html", CUT_BODY)),
                            projectFile: CAPPED,
                        });
                        assert.equal(
                            ran.everything.includes(sha256(new TextEncoder().encode(CUT_BODY))),
                            false,
                            "the log holds the hash of a body that was cut short",
                        );
                    });
                });
            });

            describe(`and the read gets ${status} with a body of exactly the cap`, () => {
                describe("when the run reaches the check", () => {
                    test("then it should end the run Errored and keep the body's hash", async () => {
                        const ran = await runWithCalls(CHECK_PLAN, {
                            route: answering(textReply(status, "text/html", AT_THE_CAP)),
                            projectFile: CAPPED,
                        });
                        assert.equal(ran.result.state, "Errored");
                        assert.equal(
                            ran.result.steps[0]?.serviceCall?.responseSha256,
                            sha256(new TextEncoder().encode(AT_THE_CAP)),
                        );
                    });
                });
            });
        });
    }

    for (const status of [200, 404, 500]) {
        describe(`given a read capped at ${CAP} bytes that gets ${status} with a body over the cap`, () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with response-too-large and end the run Failed", async () => {
                    const ran = await runWithCalls(CHECK_PLAN, {
                        route: answering(jsonReply(status, { padding: CUT_BODY })),
                        projectFile: CAPPED,
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "expectBackend failed response-too-large",
                        "expect skipped",
                    ]);
                    assert.equal(ran.result.state, "Failed");
                });
            });
        });
    }

    describe("given a read whose declaration lists 503 as a success, capped at 256 bytes", () => {
        describe("and the read gets 503 with a body over the cap", () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with response-too-large and end the run Failed", async () => {
                    const ran = await runWithCalls(CHECK_PLAN, {
                        route: answering(textReply(503, "text/html", CUT_BODY)),
                        projectFile: getOrderWith({ successStatuses: [200, 503] }),
                    });
                    assert.deepEqual(stepLines(ran.result), [
                        "expectBackend failed response-too-large",
                        "expect skipped",
                    ]);
                    assert.equal(ran.result.state, "Failed");
                });
            });
        });
    });
});
