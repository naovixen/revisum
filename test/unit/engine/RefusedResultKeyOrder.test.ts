// A result file is read and hashed by people and tools outside the engine, so a refused run writes
// its fields in one fixed order, however the run came to be refused: plan runs add their mode and
// guarantees after what refusedResult holds, suite runs before it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { refusedSuiteResult } from "@revisum/engine";
import { refusedResult } from "../../../packages/engine/src/RefusedResult.ts";
import { OPEN_ORDERS, ORIGIN, planOf, projectFileWith, runPlan } from "./run-value-examples.ts";

const SUITE_NAME = "checkout-suite";

const keysAsSerialised = (result: object): readonly string[] =>
    Object.keys(JSON.parse(JSON.stringify(result)) as object);

describe("Using the refused result", () => {
    describe("given a refusal, a target and the time taken", () => {
        describe("when the result is built", () => {
            test("then it should serialise to exactly the fields of a run where nothing ran", () => {
                const result = refusedResult({ code: "egress-unenforceable" }, SUITE_NAME, 7);
                assert.equal(
                    JSON.stringify(result),
                    '{"state":"Refused","targetId":"checkout-suite","manifest":null,"manifestHash":null,' +
                        '"steps":[],"blockedOrigins":[],"unavailable":null,' +
                        '"refusal":{"code":"egress-unenforceable"},' +
                        '"timings":{"totalMilliseconds":7,"stepMilliseconds":[]}}',
                );
            });
        });
    });

    describe("given a plan the run refuses", () => {
        const refusedPlanRun = async () => {
            const projectFile = projectFileWith({ productionOrigins: [ORIGIN] });
            const { result } = await runPlan(planOf([OPEN_ORDERS]), { projectFile });
            return result;
        };

        describe("when its result is serialised", () => {
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
        const refusedSuiteRun = () =>
            refusedSuiteResult(SUITE_NAME, { code: "egress-unenforceable" });

        describe("when its result is serialised", () => {
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
});
