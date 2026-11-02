// The session is open by the time the run logs that it has resolved and started, and a browser is
// costly to leave behind. A log that fails at either moment must not reject the run, and the session
// it opened must still close.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { LoggedEvent, RunEventSink } from "@revisum/engine";
import { memoryRunEventSink } from "../../support/memory-ports.ts";
import { fakeSession, runOnFakeSession } from "./RunOnFakeSession.ts";
import { CLOSING_CHECK, OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";

const STATES_LOGGED_WITH_THE_SESSION_OPEN = ["Resolved", "Running"] as const;

function logFailingOnState(state: string): RunEventSink {
    const kept = memoryRunEventSink();
    return {
        read: () => kept.read(),
        append(event: LoggedEvent) {
            if (event.kind === "run.state" && event.state === state) {
                throw new Error("the log could not be written");
            }
            kept.append(event);
        },
    };
}

const runWithLogFailingOn = async (context: TestContext, state: string) => {
    const close = context.mock.fn(() => Promise.resolve());
    const run = await runOnFakeSession(unsafePlan([OPEN_CART]), {
        session: fakeSession({ close }),
        events: logFailingOnState(state),
    });
    return { result: run.result, close };
};

describe("Using the run", () => {
    for (const state of STATES_LOGGED_WITH_THE_SESSION_OPEN) {
        describe(`given a log that fails as the run records ${state}`, () => {
            describe("when the run ends", () => {
                test("then it should give a result rather than reject", async (context) => {
                    await assert.doesNotReject(runWithLogFailingOn(context, state));
                });

                test("then it should account for every step", async (context) => {
                    const { result } = await runWithLogFailingOn(context, state);
                    assert.equal(result.steps.length, [OPEN_CART, CLOSING_CHECK].length);
                });

                test("then it should close the session once", async (context) => {
                    const { close } = await runWithLogFailingOn(context, state);
                    assert.equal(close.mock.callCount(), 1);
                });
            });
        });
    }

    describe("given a log that works", () => {
        describe("when the run ends", () => {
            test("then it should pass and close the session once", async (context) => {
                const { result, close } = await runWithLogFailingOn(context, "NoSuchState");
                assert.equal(result.state, "Passed");
                assert.equal(close.mock.callCount(), 1);
            });
        });
    });
});
