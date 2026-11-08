// A session that will not close, such as a browser profile Windows still holds, says nothing about
// what the steps found. The result stays as it would have been, down to its hash, so a replay on a
// calmer machine still matches, and only the log says the close failed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeSessionOnOrders, runOnFakeSession, stepSummaries } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";

const CLOSE_FAILURE = "the profile folder is still held";
const SESSION_CLOSE_FAILED = "session-close-failed";
const LONGEST_CLOSE_MILLISECONDS = 10 * 60 * 1000;
const TIME_PASSING_AT_A_GO_MILLISECONDS = 100;

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
    fakeSessionOnOrders({ close: () => Promise.reject(new Error(CLOSE_FAILURE)) });

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

            describe("and a session whose close never settles", () => {
                describe("when the run ends", () => {
                    test("then it should finish with the same result, and log session-close-failed once", async (context) => {
                        const raw = unsafePlan(verdict.steps);
                        const closing = await runOnFakeSession(raw);
                        context.mock.timers.enable({ apis: ["setTimeout"] });
                        const close = context.mock.fn(() => new Promise<never>(() => {}));
                        const progress = { isFinished: false };
                        const running = runOnFakeSession(raw, {
                            session: fakeSessionOnOrders({ close }),
                        }).finally(() => {
                            progress.isFinished = true;
                        });
                        for (
                            let waited = 0;
                            !progress.isFinished && waited < LONGEST_CLOSE_MILLISECONDS;
                            waited += TIME_PASSING_AT_A_GO_MILLISECONDS
                        ) {
                            await new Promise((resolve) => {
                                setImmediate(resolve);
                            });
                            context.mock.timers.tick(TIME_PASSING_AT_A_GO_MILLISECONDS);
                        }
                        assert.equal(close.mock.callCount(), 1, "the run reached the close");
                        assert.ok(progress.isFinished, "the run was still waiting for the close");
                        const { result, events } = await running;
                        assert.equal(result.resultHash, closing.result.resultHash);
                        assert.equal(
                            events.read().filter((event) => event.code === SESSION_CLOSE_FAILED)
                                .length,
                            1,
                        );
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
