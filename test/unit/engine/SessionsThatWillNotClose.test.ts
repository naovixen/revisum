// A session that will not close, such as a browser profile Windows still holds, says nothing about
// what the steps found. The result stays as it would have been, down to its hash, so a replay on a
// calmer machine still matches, and only the log says the close failed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeSession, runOnFakeSession, stepSummaries } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";

const CLOSE_FAILURE = "the profile folder is still held";
const SESSION_CLOSE_FAILED = "session-close-failed";

const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};

const VERDICTS: readonly {
    readonly name: string;
    readonly steps: readonly JsonRecord[];
    readonly state: string;
}[] = [
    { name: "steps that pass", steps: [OPEN_CART], state: "Passed" },
    { name: "a check that fails", steps: [OPEN_CART, FAILING_CHECK], state: "Failed" },
];

const sessionThatWillNotClose = () =>
    fakeSession({ close: () => Promise.reject(new Error(CLOSE_FAILURE)) });

describe("Using the run", () => {
    for (const verdict of VERDICTS) {
        describe(`given ${verdict.name}`, () => {
            describe("and a session whose close rejects", () => {
                describe("when the run ends", () => {
                    test("then it should give the same result as a session that closes", async () => {
                        const raw = unsafePlan(verdict.steps);
                        const closing = await runOnFakeSession(raw);
                        const stuck = await runOnFakeSession(raw, {
                            session: sessionThatWillNotClose(),
                        });
                        assert.equal(stuck.result.state, verdict.state);
                        assert.deepEqual(
                            stepSummaries(stuck.result),
                            stepSummaries(closing.result),
                        );
                        assert.equal(stuck.result.resultHash, closing.result.resultHash);
                    });

                    test("then it should log session-close-failed once", async () => {
                        const { events } = await runOnFakeSession(unsafePlan(verdict.steps), {
                            session: sessionThatWillNotClose(),
                        });
                        const logged = events
                            .read()
                            .filter((event) => event.code === SESSION_CLOSE_FAILED);
                        assert.equal(logged.length, 1);
                        assert.equal(logged[0]?.detail, CLOSE_FAILURE);
                    });

                    test("then it should keep the failure's text out of the result", async () => {
                        const { result } = await runOnFakeSession(unsafePlan(verdict.steps), {
                            session: sessionThatWillNotClose(),
                        });
                        const kept = JSON.stringify(result);
                        assert.equal(kept.includes(CLOSE_FAILURE), false);
                        assert.equal(kept.includes(SESSION_CLOSE_FAILED), false);
                    });
                });
            });

            describe("and a session that closes", () => {
                describe("when the run ends", () => {
                    test("then it should log no failed close", async () => {
                        const { events } = await runOnFakeSession(unsafePlan(verdict.steps));
                        assert.equal(
                            events.read().some((event) => event.code === SESSION_CLOSE_FAILED),
                            false,
                        );
                    });
                });
            });
        });
    }
});
