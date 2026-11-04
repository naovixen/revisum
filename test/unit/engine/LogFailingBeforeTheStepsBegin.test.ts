// The session is open by the time the run logs that it has resolved and started, and a browser is
// costly to leave behind. A log that fails at either moment, or earlier as the run is planned, must
// not reject the run, and the session it opened must still close. A run refused before any session
// opens has its refusal to report, whether or not the log can take it.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { RunEventSink } from "@revisum/engine";
import { memoryRunEventSink } from "../../support/memory-ports.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
import { environmentSecretStore } from "@revisum/engine";
import {
    CLOSING_CHECK,
    DATABASE_SECRET,
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";
import { fakeRunEventSinkFailingOn } from "#test-support/fakes/FakeRunEventSink.ts";

const STATES_LOGGED_BEFORE_THE_STEPS = ["Planned", "Resolved", "Running"] as const;
const STATES_LOGGED_FOR_A_REFUSAL: readonly {
    readonly name: string;
    readonly states: readonly string[];
}[] = [
    { name: "as the run records Refused", states: ["Refused"] },
    { name: "as the run records Planned and Refused", states: ["Planned", "Refused"] },
];

const FILL_SECRET: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Access code" },
    value: { secretName: DATABASE_SECRET },
};

const logFailingOnStates = (states: readonly string[]): RunEventSink =>
    fakeRunEventSinkFailingOn(
        (event) => event.kind === "run.state" && states.some((state) => state === event.state),
    );

const logFailingOnState = (state: string): RunEventSink => logFailingOnStates([state]);

// A run refused for a secret the store does not hold, before any session opens.
const runRefused = (events: RunEventSink) =>
    runOnFakeSession(unsafePlan([OPEN_CART, FILL_SECRET]), {
        secrets: environmentSecretStore({}),
        events,
    });

const runWithLogFailingOn = async (context: TestContext, state: string) => {
    const close = context.mock.fn(() => Promise.resolve());
    const run = await runOnFakeSession(unsafePlan([OPEN_CART]), {
        session: fakeSessionOnOrders({ close }),
        events: logFailingOnState(state),
    });
    return { result: run.result, close };
};

describe("Using the run", () => {
    for (const state of STATES_LOGGED_BEFORE_THE_STEPS) {
        describe(`given a log that fails as the run records ${state}`, () => {
            describe("when the run ends", () => {
                test("then it should give a result rather than reject", async (context) => {
                    await assert.doesNotReject(runWithLogFailingOn(context, state));
                });

                test("then it should end Errored", async (context) => {
                    const { result } = await runWithLogFailingOn(context, state);
                    assert.equal(result.state, "Errored", JSON.stringify(result.steps));
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

    for (const { name, states } of STATES_LOGGED_FOR_A_REFUSAL) {
        describe(`given a log that fails ${name}`, () => {
            describe("when the run is refused", () => {
                test("then it should give that refusal rather than reject", async () => {
                    const { result } = await runRefused(logFailingOnStates(states));
                    assert.equal(result.state, "Refused");
                    assert.equal(result.refusal?.code, "secret-missing");
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

        describe("when the run is refused", () => {
            test("then it should log the refusal", async () => {
                const { result, events } = await runRefused(memoryRunEventSink());
                assert.equal(result.refusal?.code, "secret-missing");
                assert.ok(
                    events
                        .read()
                        .some((event) => event.kind === "run.state" && event.state === "Refused"),
                );
            });
        });
    });
});
