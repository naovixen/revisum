// A suite that ran nothing says nothing about the product, however cleanly it exits. A report whose
// tests were all skipped is as vacuous as one with no tests, and a declared project that ran no test
// is a hole in what the suite covered. Neither may open the merge gate.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    declaredCheckoutSuite,
    evidenceRun,
    opensMergeGate,
    recordedReport,
    specPath,
    withoutSpec,
    type JsonRecord,
} from "./examples/EvidenceRun.ts";
import { withValue } from "../plan/examples/GoldenPlan.ts";

// Highest first, because removing a spec moves those after it.
const withoutSpecs = (report: JsonRecord, indexes: readonly number[]): JsonRecord =>
    indexes.reduce((kept, index) => withoutSpec(kept, index), report);

const EACH_OUTCOME_REPORT = recordedReport("each-outcome");
const ONLY_SKIPPED = withoutSpecs(EACH_OUTCOME_REPORT, [4, 2, 1, 0]);
const PASSED_AND_SKIPPED = withoutSpecs(EACH_OUTCOME_REPORT, [4, 2, 1]);
const NO_TESTS = withValue(EACH_OUTCOME_REPORT, ["suites"], []);

const NOTHING_EXECUTED: readonly { readonly name: string; readonly report: JsonRecord }[] = [
    { name: "every test skipped", report: ONLY_SKIPPED },
    { name: "no tests", report: NO_TESTS },
];

// The recorded report with its two malformed criterion annotations left out: they would raise a
// review item, which keeps the merge gate shut for a reason of its own.
const PASSING_WITH_NOTHING_TO_REVIEW = withValue(
    recordedReport("passing-with-criteria"),
    [...specPath(1), "tests", 0, "annotations"],
    [],
);

describe("Using an evidence result", () => {
    for (const { name, report } of NOTHING_EXECUTED) {
        describe(`given a report with ${name} and an exit code of 0`, () => {
            describe("when the result is built", () => {
                test("then it should not end Passed", () => {
                    assert.notEqual(evidenceRun(report, { exitCode: 0 }).state, "Passed");
                });

                test("then it should say the run was vacuous", () => {
                    const { evidence } = evidenceRun(report, { exitCode: 0 });
                    assert.equal(evidence?.outcomeCode, "vacuous");
                });

                test("then it should keep the merge gate shut", () => {
                    assert.equal(opensMergeGate(evidenceRun(report, { exitCode: 0 })), false);
                });
            });
        });
    }

    describe("given a report with one test passed and one skipped", () => {
        describe("when the result is built", () => {
            test("then it should end Passed and open the merge gate", () => {
                const result = evidenceRun(PASSED_AND_SKIPPED, { exitCode: 0 });
                assert.equal(result.state, "Passed");
                assert.equal(result.evidence?.outcomeCode, undefined);
                assert.equal(opensMergeGate(result), true);
            });
        });
    });

    describe("given a suite declaring a project the report has no tests for", () => {
        const suite = declaredCheckoutSuite({ projects: ["chromium", "webkit"] });

        describe("when the result is built", () => {
            test("then it should keep the merge gate shut", () => {
                const result = evidenceRun(PASSING_WITH_NOTHING_TO_REVIEW, { suite });
                assert.equal(opensMergeGate(result), false);
            });
        });
    });

    describe("given a suite whose declared projects all have tests in the report", () => {
        const suite = declaredCheckoutSuite({ projects: ["chromium", "firefox"] });

        describe("when the result is built", () => {
            test("then it should end Passed and open the merge gate", () => {
                const result = evidenceRun(PASSING_WITH_NOTHING_TO_REVIEW, { suite });
                assert.equal(result.state, "Passed");
                assert.equal(opensMergeGate(result), true);
            });
        });
    });
});
