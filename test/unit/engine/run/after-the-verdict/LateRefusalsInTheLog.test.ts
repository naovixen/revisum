// A request decision the browser refuses after the last step's verdict turns that step into an
// adapter-error failure in the result. The event log must tell the same story: whoever reads the log
// alone must not see a pass where the result says the run could not test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    EventKind,
    success,
    type LoggedEvent,
    type RunResult,
    type Session,
} from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession } from "../examples/RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "../../plan/unsafe-features/examples/UnsafePlan.ts";
import { closedSession } from "#test-support/fakes/session/FakeSession.ts";

const REFUSAL = "the browser would not let a held request go on";

// A session that reports a refused decision only once it has closed, so no step sees it while it runs.
function sessionRefusingAfterClose(isRefusing: boolean): Session {
    return fakeSessionOnOrders({
        close: () =>
            Promise.resolve(
                closedSession(isRefusing ? { refusedRequestDecisions: success([REFUSAL]) } : {}),
            ),
    });
}

type Outcome = { readonly outcome: unknown; readonly code: unknown };

// What the log last said of the step at `stepIndex`, which is what a reader of the log takes as its end.
function loggedEndOf(events: readonly LoggedEvent[], stepIndex: number): Outcome | undefined {
    const ends = events.filter(
        (event) => event.kind === EventKind.StepEnd && event.stepIndex === stepIndex,
    );
    const last = ends.at(-1);
    return last === undefined ? undefined : { outcome: last.outcome, code: last.code };
}

function lastStepOf(result: RunResult): Outcome & { readonly index: number } {
    const last = result.steps.at(-1);
    assert.ok(last !== undefined, "the run has steps");
    return { index: last.index, outcome: last.outcome, code: last.code };
}

const CASES: readonly {
    readonly name: string;
    readonly isRefusing: boolean;
    readonly state: RunResult["state"];
    readonly expected: Outcome;
}[] = [
    {
        name: "and the browser refuses a request decision after the last step's verdict",
        isRefusing: true,
        state: "Errored",
        expected: { outcome: "failed", code: "adapter-error" },
    },
    {
        name: "and the browser refuses nothing",
        isRefusing: false,
        state: "Passed",
        expected: { outcome: "passed", code: undefined },
    },
];

describe("Using the run", () => {
    describe("given a plan whose steps all pass", () => {
        for (const late of CASES) {
            describe(late.name, () => {
                describe("when the run ends", () => {
                    test("then it should give the last step the same outcome in the log as in the result", async () => {
                        const { result, events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                            session: sessionRefusingAfterClose(late.isRefusing),
                        });
                        const { index, ...inResult } = lastStepOf(result);
                        assert.deepEqual(
                            {
                                state: result.state,
                                inResult,
                                inLog: loggedEndOf(events.read(), index),
                            },
                            { state: late.state, inResult: late.expected, inLog: late.expected },
                        );
                    });
                });
            });
        }
    });
});
