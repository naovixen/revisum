// Playwright gives each test a status of its own beside its result's. "unexpected" says the test did
// not end as the suite expected, whatever its one result says, so a report that claims both a passed
// result and an unexpected test cannot be a pass, even with an exit code of 0.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    evidenceMergeGateOpen,
    evidenceResult,
    parseSuiteReport,
    type RunResult,
} from "@revisum/engine";
import {
    evidenceContext,
    evidenceLimits,
    recordedReport,
    specPath,
    type JsonRecord,
} from "./examples/EvidenceRun.ts";
import { withValue } from "../plan/examples/GoldenPlan.ts";

const FIRST_TEST = [...specPath(0), "tests", 0];

// The recorded report with its two malformed criterion annotations left out: they would raise a
// review item, which keeps the merge gate shut for a reason of its own.
const PASSING_WITH_NOTHING_TO_REVIEW = withValue(
    recordedReport("passing-with-criteria"),
    [...specPath(1), "tests", 0, "annotations"],
    [],
);

const reportWhoseFirstTestIs = (status: string): JsonRecord =>
    withValue(PASSING_WITH_NOTHING_TO_REVIEW, [...FIRST_TEST, "status"], status);

// The result of the report, or null when the decoder refuses it: a refusal also ends the run
// without a pass.
const resultOf = (report: JsonRecord, exitCode: number): RunResult | null => {
    const decoded = parseSuiteReport(report, evidenceLimits());
    return decoded.ok
        ? evidenceResult(decoded.value, [], [], evidenceContext(report, { exitCode }))
        : null;
};

describe("Using an evidence result", () => {
    describe("given a test whose status is unexpected and whose result passed", () => {
        describe("when the suite exits 0", () => {
            test("then it should not end Passed", () => {
                const result = resultOf(reportWhoseFirstTestIs("unexpected"), 0);
                assert.notEqual(result?.state, "Passed");
            });

            test("then it should keep the merge gate shut", () => {
                const result = resultOf(reportWhoseFirstTestIs("unexpected"), 0);
                assert.equal(result !== null && evidenceMergeGateOpen(result), false);
            });
        });

        describe("when the suite exits 1", () => {
            test("then it should not end Passed", () => {
                const result = resultOf(reportWhoseFirstTestIs("unexpected"), 1);
                assert.notEqual(result?.state, "Passed");
            });
        });
    });

    describe("given a test whose status is expected and whose result passed", () => {
        describe("when the suite exits 0", () => {
            test("then it should end Passed and open the merge gate", () => {
                const result = resultOf(reportWhoseFirstTestIs("expected"), 0);
                assert.equal(result?.state, "Passed");
                assert.equal(evidenceMergeGateOpen(result), true);
            });
        });
    });
});
