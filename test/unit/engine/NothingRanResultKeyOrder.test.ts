// A result file is read and hashed by people and tools outside the engine, so a run that ended before
// any step writes its fields in one fixed order, however it came to end: plan runs add their mode and
// guarantees after those fields, suite runs before them, and only a refusal has a refusal field.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, refusedSuiteResult, type Clock, type RunResult } from "@revisum/engine";
import { runOnFakeSession } from "./RunOnFakeSession.ts";
import {
    FEATURES,
    OPEN_CART,
    ORIGIN,
    TARGET_ID,
    unsafePlan,
    unsafeProjectFile,
} from "./unsafe-feature-steps.ts";

const SUITE_NAME = "checkout-suite";
const TIME_TAKEN = 7;

// Reads as the start of the run the first time, and as TIME_TAKEN later every time after.
const clockThatTakes = (milliseconds: number): Clock => {
    let hasStarted = false;
    return {
        now: () => {
            const reading = hasStarted ? milliseconds : 0;
            hasStarted = true;
            return reading;
        },
        sleep: () => Promise.resolve(),
    };
};

const keysAsSerialised = (result: object): readonly string[] =>
    Object.keys(JSON.parse(JSON.stringify(result)) as object);

const ADDED_BY_THE_KIND_OF_RUN: readonly string[] = [
    "mode",
    "guarantees",
    "resultHash",
    "evidenceHash",
];

const serialisedWithoutWhatTheKindOfRunAdds = (result: RunResult): string =>
    JSON.stringify(
        Object.fromEntries(
            Object.entries(result).filter(([key]) => !ADDED_BY_THE_KIND_OF_RUN.includes(key)),
        ),
    );

const refusedPlanRun = async (): Promise<RunResult> => {
    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
        projectFile: unsafeProjectFile(FEATURES, { productionOrigins: [ORIGIN] }),
        clock: clockThatTakes(TIME_TAKEN),
    });
    return result;
};

const planRunOnAnUnavailableTarget = async (): Promise<RunResult> => {
    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
        open: () =>
            Promise.resolve(failure({ reason: "launch-failed", detail: "the browser is broken" })),
        clock: clockThatTakes(TIME_TAKEN),
    });
    return result;
};

const refusedSuiteRun = (): RunResult =>
    refusedSuiteResult(SUITE_NAME, { code: "egress-unenforceable" });

describe("Using the result of a run where nothing ran", () => {
    describe("given a plan the run refuses", () => {
        describe("when its result is serialised", () => {
            test("then it should write exactly the common fields, holding the refusal and the time taken", async () => {
                assert.equal(
                    serialisedWithoutWhatTheKindOfRunAdds(await refusedPlanRun()),
                    `{"state":"Refused","targetId":"${TARGET_ID}","manifest":null,"manifestHash":null,` +
                        '"steps":[],"blockedOrigins":[],"unavailable":null,' +
                        `"refusal":{"code":"origin-not-allowed","origin":"${ORIGIN}"},` +
                        `"timings":{"totalMilliseconds":${TIME_TAKEN},"stepMilliseconds":[]}}`,
                );
            });

            test("then it should write the common fields, then the mode and guarantees, then the hashes", async () => {
                assert.deepEqual(keysAsSerialised(await refusedPlanRun()), [
                    "state",
                    "targetId",
                    "manifest",
                    "manifestHash",
                    "steps",
                    "blockedOrigins",
                    "unavailable",
                    "refusal",
                    "timings",
                    "mode",
                    "guarantees",
                    "resultHash",
                    "evidenceHash",
                ]);
            });
        });
    });

    describe("given a suite the run refuses", () => {
        describe("when its result is serialised", () => {
            test("then it should write exactly the common fields, holding the refusal and no time", () => {
                assert.equal(
                    serialisedWithoutWhatTheKindOfRunAdds(refusedSuiteRun()),
                    `{"state":"Refused","targetId":"${SUITE_NAME}","manifest":null,"manifestHash":null,` +
                        '"steps":[],"blockedOrigins":[],"unavailable":null,' +
                        '"refusal":{"code":"egress-unenforceable"},' +
                        '"timings":{"totalMilliseconds":0,"stepMilliseconds":[]}}',
                );
            });

            test("then it should write the state, then the mode and guarantees, then the other common fields, then the hashes", () => {
                assert.deepEqual(keysAsSerialised(refusedSuiteRun()), [
                    "state",
                    "mode",
                    "guarantees",
                    "targetId",
                    "manifest",
                    "manifestHash",
                    "steps",
                    "blockedOrigins",
                    "unavailable",
                    "refusal",
                    "timings",
                    "resultHash",
                    "evidenceHash",
                ]);
            });

            test("then it should name the suite as the target and take no time", () => {
                const { state, targetId, timings } = refusedSuiteRun();
                assert.deepEqual(
                    { state, targetId, timings },
                    {
                        state: "Refused",
                        targetId: SUITE_NAME,
                        timings: { totalMilliseconds: 0, stepMilliseconds: [] },
                    },
                );
            });
        });
    });

    describe("given a plan run whose browser cannot be opened", () => {
        describe("when its result is serialised", () => {
            test("then it should write exactly the common fields, holding why and the time taken, with no refusal", async () => {
                assert.equal(
                    serialisedWithoutWhatTheKindOfRunAdds(await planRunOnAnUnavailableTarget()),
                    `{"state":"TargetUnavailable","targetId":"${TARGET_ID}","manifest":null,"manifestHash":null,` +
                        '"steps":[],"blockedOrigins":[],' +
                        '"unavailable":{"reason":"launch-failed","detail":"the browser is broken"},' +
                        `"timings":{"totalMilliseconds":${TIME_TAKEN},"stepMilliseconds":[]}}`,
                );
            });

            test("then it should write the common fields, then the mode and guarantees, then the hashes", async () => {
                assert.deepEqual(keysAsSerialised(await planRunOnAnUnavailableTarget()), [
                    "state",
                    "targetId",
                    "manifest",
                    "manifestHash",
                    "steps",
                    "blockedOrigins",
                    "unavailable",
                    "timings",
                    "mode",
                    "guarantees",
                    "resultHash",
                    "evidenceHash",
                ]);
            });
        });
    });
});
