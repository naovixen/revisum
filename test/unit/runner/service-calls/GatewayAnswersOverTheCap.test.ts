// The real caller stops reading a body at its cap, but it has read the status by then, and only the
// engine can say what that status means. So it answers with the status and the body cut one byte past
// the cap, whichever status it is, and the engine's own check of the cap refuses what it has to.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serviceRequest, withCallerHarness, type Answer } from "../support/LocalService.ts";

const CAP = 1024;
const OVER_THE_CAP = CAP + 4096;

const sizedAnswerWithStatus =
    (status: number, length: number, isChunked: boolean): Answer =>
    (received, response) => {
        response.writeHead(status, {
            "content-type": "text/html",
            ...(isChunked ? {} : { "content-length": String(length) }),
        });
        response.end("g".repeat(length));
    };

describe("Using the service caller", () => {
    for (const status of [200, 404, 502, 503, 504]) {
        for (const { written, isChunked } of [
            { written: "with its length declared", isChunked: false },
            { written: "sent chunked, with no length", isChunked: true },
        ]) {
            describe(`given a service answering ${status} with a body over the cap, ${written}`, () => {
                describe("when the call is made", () => {
                    test("then it should answer with the status and the body cut one byte past the cap", async () => {
                        await withCallerHarness(
                            { answer: sizedAnswerWithStatus(status, OVER_THE_CAP, isChunked) },
                            async ({ caller, service }) => {
                                const answered = await caller.call(
                                    serviceRequest(service.origin, { maximumResponseBytes: CAP }),
                                );
                                assert.ok(answered.ok, JSON.stringify(answered));
                                assert.equal(answered.value.status, status);
                                assert.equal(answered.value.mediaType, "text/html");
                                assert.equal(answered.value.body.length, CAP + 1);
                            },
                        );
                    });
                });
            });
        }
    }

    describe("given a service answering 502 with a body of exactly the cap", () => {
        describe("when the call is made", () => {
            test("then it should answer with the whole body", async () => {
                await withCallerHarness(
                    { answer: sizedAnswerWithStatus(502, CAP, false) },
                    async ({ caller, service }) => {
                        const answered = await caller.call(
                            serviceRequest(service.origin, { maximumResponseBytes: CAP }),
                        );
                        assert.ok(answered.ok, JSON.stringify(answered));
                        assert.equal(answered.value.status, 502);
                        assert.equal(answered.value.body.length, CAP);
                    },
                );
            });
        });
    });
});
