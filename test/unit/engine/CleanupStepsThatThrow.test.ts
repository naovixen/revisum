// Cleanup runs after the verdict is known, so nothing it does may cost the run its result: a person
// still needs to read what the steps found, and to be told test data may be left behind. The log is
// the one thing a database cleanup step does that nothing catches, so a log that fails while it
// writes that step's record is what makes the step throw.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunEventSink, RunResult } from "@revisum/engine";
import { SEED_ORDERS, WIPE_ORDERS, commandProjectFile } from "./database-command-examples.ts";
import { runOnFakeSession, stepSummaries } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";
import { fakeRunEventSinkFailingOn } from "#test-support/fakes/FakeRunEventSink.ts";

const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};

const VERDICTS: readonly {
    readonly name: string;
    readonly steps: readonly JsonRecord[];
    readonly state: RunResult["state"];
    readonly summaries: readonly (readonly [string, string | undefined])[];
}[] = [
    {
        name: "steps that pass",
        steps: [OPEN_CART],
        state: "Passed",
        summaries: [
            ["passed", undefined],
            ["passed", undefined],
        ],
    },
    {
        name: "a check that fails",
        steps: [OPEN_CART, FAILING_CHECK],
        state: "Failed",
        summaries: [
            ["passed", undefined],
            ["failed", "assertion-failed"],
            ["skipped", undefined],
        ],
    },
];

// A log that fails once, as a full disk or a closed file does, on the first database command's record.
function logFailingOnFirstDatabaseCommand(): RunEventSink {
    let hasFailed = false;
    return fakeRunEventSinkFailingOn((event) => {
        const isFirst = event.kind === "database.command" && !hasFailed;
        hasFailed ||= isFirst;
        return isFirst;
    });
}

const runWithFailingLog = (
    steps: readonly JsonRecord[],
    cleanup: readonly JsonRecord[],
): ReturnType<typeof runOnFakeSession> =>
    runOnFakeSession(unsafePlan(steps, { cleanup }), {
        projectFile: commandProjectFile(),
        events: logFailingOnFirstDatabaseCommand(),
    });

const cleanupSummaries = (result: RunResult) =>
    (result.cleanup ?? []).map((done) => [done.outcome, done.code] as const);

describe("Using the run", () => {
    for (const verdict of VERDICTS) {
        describe(`given ${verdict.name}`, () => {
            describe("and a database cleanup step that throws", () => {
                describe("when the run ends", () => {
                    test("then it should keep the steps' result", async () => {
                        const { result } = await runWithFailingLog(verdict.steps, [WIPE_ORDERS]);
                        assert.deepEqual(
                            { state: result.state, steps: stepSummaries(result) },
                            { state: verdict.state, steps: verdict.summaries },
                        );
                    });

                    test("then it should record the step as cleanup-failed and raise a review item", async () => {
                        const { result } = await runWithFailingLog(verdict.steps, [WIPE_ORDERS]);
                        assert.deepEqual(cleanupSummaries(result), [["failed", "cleanup-failed"]]);
                        assert.deepEqual(result.reviewItems, [
                            { code: "cleanup-failed", cleanupIndex: 0 },
                        ]);
                    });
                });
            });

            describe("and a database cleanup step whose command cannot start", () => {
                describe("when the run ends", () => {
                    test("then it should keep the steps' result and raise a review item", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan(verdict.steps, { cleanup: [WIPE_ORDERS] }),
                            {
                                projectFile: commandProjectFile(),
                                commandRoute: () => {
                                    throw new Error("the container could not start");
                                },
                            },
                        );
                        assert.equal(result.state, verdict.state, JSON.stringify(result.steps));
                        assert.deepEqual(cleanupSummaries(result), [["failed", "cleanup-failed"]]);
                        assert.deepEqual(result.reviewItems, [
                            { code: "cleanup-failed", cleanupIndex: 0 },
                        ]);
                    });
                });
            });

            describe("and a database cleanup step that works", () => {
                describe("when the run ends", () => {
                    test("then it should raise no review item", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan(verdict.steps, { cleanup: [WIPE_ORDERS] }),
                            { projectFile: commandProjectFile() },
                        );
                        assert.equal(result.state, verdict.state, JSON.stringify(result.steps));
                        assert.deepEqual(cleanupSummaries(result), [["passed", undefined]]);
                        assert.equal(result.reviewItems, undefined);
                    });
                });
            });
        });
    }

    describe("given a database cleanup step that throws", () => {
        describe("and another cleanup step after it", () => {
            describe("when the run ends", () => {
                test("then it should still run the later step", async () => {
                    const { result } = await runWithFailingLog(
                        [OPEN_CART],
                        [WIPE_ORDERS, SEED_ORDERS],
                    );
                    assert.deepEqual(cleanupSummaries(result), [
                        ["failed", "cleanup-failed"],
                        ["passed", undefined],
                    ]);
                });
            });
        });
    });
});
