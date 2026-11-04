// A manifest and a recording are read back from JSON files, so anything JSON cannot write is refused
// whole, at the top, as a version this reader does not know.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { decodeManifest } from "@revisum/engine";
import { classInstanceHolding } from "../../support/ClassInstanceHolding.ts";
import {
    closedScenario,
    refused,
    removeFakeExecutables,
    replayed,
    replayRun,
    runScenario,
    type ScenarioRun,
} from "./replay-examples.ts";
import {
    callPlanOf,
    callProjectFile,
    CREATE_ORDER,
    SECRET_VALUES,
} from "./service-call-examples.ts";

const VERSION_UNSUPPORTED_AT_THE_TOP = { code: "version-unsupported", path: "$" };

const jsonOf = (value: unknown): object => {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    assert.ok(typeof copy === "object" && copy !== null);
    return copy;
};

describe("Using a run's replay files", () => {
    let ran: ScenarioRun;

    before(async () => {
        ran = await runScenario(
            {
                ...closedScenario(
                    callProjectFile({}, {}, { replay: { recordReplies: true } }),
                    callPlanOf([CREATE_ORDER]),
                ),
                environment: SECRET_VALUES,
            },
            { record: true },
        );
    });

    after(removeFakeExecutables);

    describe("given a Date as a manifest", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the top", () => {
                assert.deepEqual(decodeManifest(new Date(0)), {
                    ok: false,
                    error: VERSION_UNSUPPORTED_AT_THE_TOP,
                });
            });
        });
    });

    describe("given a class instance holding exactly a manifest's fields", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the top", () => {
                const input = classInstanceHolding(jsonOf(ran.manifest));
                assert.deepEqual(decodeManifest(input), {
                    ok: false,
                    error: VERSION_UNSUPPORTED_AT_THE_TOP,
                });
            });
        });
    });

    describe("given the manifest as JSON writes it", () => {
        describe("when it is decoded", () => {
            test("then it should read it back", () => {
                assert.equal(decodeManifest(jsonOf(ran.manifest)).ok, true);
            });
        });
    });

    describe("given a Date as a recording", () => {
        describe("when a run with calls is replayed", () => {
            test("then it should refuse it at the top", async () => {
                const replay = await replayRun(ran, { recording: new Date(0) });
                assert.deepEqual(refused(replay.answer), VERSION_UNSUPPORTED_AT_THE_TOP);
            });
        });
    });

    describe("given a class instance holding exactly a recording's fields", () => {
        describe("when a run with calls is replayed", () => {
            test("then it should refuse it at the top", async () => {
                const recording = classInstanceHolding(jsonOf(ran.recording));
                const replay = await replayRun(ran, { recording });
                assert.deepEqual(refused(replay.answer), VERSION_UNSUPPORTED_AT_THE_TOP);
            });
        });
    });

    describe("given the recording as JSON writes it", () => {
        describe("when a run with calls is replayed", () => {
            test("then it should replay the run", async () => {
                const replay = await replayRun(ran);
                assert.equal(replayed(replay.answer).identical, true);
            });
        });
    });
});
