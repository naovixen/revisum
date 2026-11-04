// When a session's port refuses a step, the step fails with the port's code and nothing after it runs.
// An advance of the clock never turns into a real wait, whatever the port does.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { failure, type DriverError, type Session } from "@revisum/engine";
import {
    COPY_LINK,
    HOUR,
    advanceClock,
    rememberClipboard,
} from "./clock-and-clipboard-examples.ts";
import { OPEN_ORDERS, planOf, runPlan, type JsonRecord } from "./run-value-examples.ts";
import { startStub, stopStub, stubProjectFile } from "./stub-and-storage-examples.ts";

const REFUSED: DriverError = { code: "not-actionable", detail: "the port refuses" };
const AFTER: JsonRecord = {
    type: "click",
    locator: { by: "role", role: "button", name: "Continue" },
};
const NETWORK_PROJECT = stubProjectFile();

const NETWORK_REFUSING_STUBS: Partial<Session> = {
    network: {
        startStub: () => Promise.resolve(failure(REFUSED)),
        stopStub: () => Promise.resolve(failure(REFUSED)),
        stubAnswers: () => [],
        observe: () => Promise.resolve(failure(REFUSED)),
        exchanges: () => [],
        quiet: () => Promise.resolve(failure(REFUSED)),
    },
};
const CLOCK_REFUSING: Partial<Session> = {
    clock: { advance: () => Promise.resolve(failure(REFUSED)) },
};
const CLIPBOARD_REFUSING: Partial<Session> = {
    clipboard: { readText: () => Promise.resolve(failure(REFUSED)) },
};

// Every real timer the run starts, by its delay, so a test can see that no advance becomes a wait.
let timerDelays: number[] = [];
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
    timerDelays = [];
    const recordTimeout = (handler: () => void, delay?: number, ...rest: unknown[]) => {
        timerDelays.push(delay ?? 0);
        return realSetTimeout(handler, delay, ...rest);
    };
    globalThis.setTimeout = Object.assign(recordTimeout, realSetTimeout) as typeof setTimeout;
});
afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
});

describe("Using a run", () => {
    describe("given an advance of one hour", () => {
        describe("when it is run", () => {
            test("then it should wait no real time, with no timer near its length", async () => {
                const started = performance.now();
                const { result } = await runPlan(
                    planOf([OPEN_ORDERS, advanceClock(1, "hours"), AFTER]),
                );
                const elapsed = performance.now() - started;
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.ok(elapsed < 10_000, `the run took ${Math.round(elapsed)} ms`);
                assert.deepEqual(
                    timerDelays.filter((delay) => delay >= HOUR / 2),
                    [],
                    "no timer of half the advance or more",
                );
            });
        });
    });

    describe("given a timer as long as the advance", () => {
        describe("when it starts", () => {
            test("then it should be seen by the timer record", () => {
                const timer = setTimeout(() => undefined, HOUR);
                clearTimeout(timer);
                assert.deepEqual(
                    timerDelays.filter((delay) => delay >= HOUR / 2),
                    [HOUR],
                );
            });
        });
    });

    describe("given a clock that refuses to advance", () => {
        describe("when an advance is run before the first navigation", () => {
            test("then it should fail the step, with the page never loaded", async () => {
                const { result, recording } = await runPlan(
                    planOf([advanceClock(10, "minutes"), OPEN_ORDERS]),
                    { session: CLOCK_REFUSING },
                );
                assert.equal(result.state, "Failed");
                assert.deepEqual(
                    result.steps.map((step) => [step.index, step.outcome, step.code]),
                    [
                        [0, "failed", "not-actionable"],
                        [1, "skipped", undefined],
                        [2, "skipped", undefined],
                    ],
                );
                assert.deepEqual(recording.navigations, []);
            });
        });
    });

    describe("given a clipboard that refuses to be read, after a copy click", () => {
        describe("when a remember from it comes before a fill that uses it", () => {
            test("then it should fail the remember and skip the fill, never sent with empty text", async () => {
                const fill = {
                    type: "fill",
                    locator: { by: "label", label: "Invite link" },
                    value: { valueName: "inviteLink" },
                };
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, COPY_LINK, rememberClipboard("inviteLink"), fill]),
                    { session: CLIPBOARD_REFUSING },
                );
                assert.equal(result.state, "Failed");
                assert.deepEqual(
                    result.steps.map((step) => [step.index, step.outcome, step.code]),
                    [
                        [0, "passed", undefined],
                        [1, "passed", undefined],
                        [2, "failed", "not-actionable"],
                        [3, "skipped", undefined],
                        [4, "skipped", undefined],
                    ],
                );
                assert.deepEqual(
                    recording.actions.map((sent) => sent.type),
                    ["click"],
                );
            });
        });
    });

    describe("given a network port that refuses a stub", () => {
        describe("when a stop follows the start that failed", () => {
            test("then it should skip the stop, never performed alone", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, startStub("cartEmpty"), stopStub("cartEmpty"), AFTER]),
                    { projectFile: NETWORK_PROJECT, session: NETWORK_REFUSING_STUBS },
                );
                assert.equal(result.state, "Failed");
                assert.deepEqual(
                    result.steps.map((step) => [step.index, step.type, step.outcome, step.code]),
                    [
                        [0, "navigate", "passed", undefined],
                        [1, "stub", "failed", "not-actionable"],
                        [2, "stub", "skipped", undefined],
                        [3, "click", "skipped", undefined],
                        [4, "expect", "skipped", undefined],
                    ],
                );
                assert.deepEqual(recording.actions, []);
            });
        });

        describe("when the stub is started before the first navigation", () => {
            test("then it should never load a page behind a stub that did not start", async () => {
                const { result, recording } = await runPlan(
                    planOf([startStub("cartEmpty"), OPEN_ORDERS]),
                    { projectFile: NETWORK_PROJECT, session: NETWORK_REFUSING_STUBS },
                );
                assert.equal(result.state, "Failed");
                assert.deepEqual(
                    result.steps.map((step) => [step.index, step.outcome, step.code]),
                    [
                        [0, "failed", "not-actionable"],
                        [1, "skipped", undefined],
                        [2, "skipped", undefined],
                    ],
                );
                assert.deepEqual(recording.navigations, []);
            });
        });
    });
});
