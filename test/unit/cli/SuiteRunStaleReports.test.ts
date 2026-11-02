// The output folder belongs to one run of one pass. A report left there by an earlier run, an earlier
// pass or the setup command says nothing about this run, so a suite command that exits 0 without
// writing one has told Revisum nothing, and must not inherit a pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evidenceMergeGateOpen, type RunResult } from "@revisum/engine";
import { testsOf } from "../engine/evidence-examples.ts";
import { outputFolder, reportWithFailure } from "./suite-run-examples.ts";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    suiteThatWrites,
    writeReportInto,
} from "./SuiteThatWrites.ts";

const PASSING_REPORT = passingReportWithNothingToReview();

const assertReadNoReport = (result: RunResult): void => {
    assert.equal(result.state, "Errored", JSON.stringify(result.evidence));
    assert.equal(result.evidence?.outcomeCode, "suite-report-unread");
    assert.deepEqual(
        result.evidence?.decodeErrors?.map((error) => error.code),
        ["suite-report-missing"],
    );
    assert.deepEqual(testsOf(result), []);
    assert.equal(evidenceMergeGateOpen(result), false);
};

const folderHoldingAPass = (): string => {
    const folder = outputFolder();
    writeReportInto(folder, PASSING_REPORT);
    return folder;
};

describe("Using a suite run", () => {
    describe("given a passing report left in the output folder by an earlier run", () => {
        describe("when the suite exits 0 without writing a report", () => {
            test("then it should end Errored, with the report unread", async () => {
                const result = await runSuiteOn(suiteThatWrites({}), {
                    outputDirectory: folderHoldingAPass(),
                });
                assertReadNoReport(result);
            });
        });

        describe("when the suite is stopped at its timeout without writing a report", () => {
            test("then it should list no test as passed", async () => {
                const result = await runSuiteOn(
                    suiteThatWrites({ timedOut: true, exitCode: 137 }),
                    { outputDirectory: folderHoldingAPass() },
                );
                assert.equal(result.state, "Errored");
                assert.equal(result.evidence?.outcomeCode, "suite-timeout");
                assert.deepEqual(testsOf(result), []);
            });
        });

        describe("when the suite writes a failing report of its own", () => {
            test("then it should end Failed on that report", async () => {
                const report = reportWithFailure("Error: the total is wrong");
                const result = await runSuiteOn(
                    suiteThatWrites({
                        exitCode: 1,
                        duringSuite: (folder) => writeReportInto(folder, report),
                    }),
                    { outputDirectory: folderHoldingAPass() },
                );
                assert.equal(result.state, "Failed");
            });
        });
    });

    describe("given a setup command that writes a passing report", () => {
        describe("when the suite exits 0 without writing a report", () => {
            test("then it should end Errored, with the report unread", async () => {
                const result = await runSuiteOn(
                    suiteThatWrites({
                        duringSetup: (folder) => writeReportInto(folder, PASSING_REPORT),
                    }),
                );
                assertReadNoReport(result);
            });
        });
    });

    describe("given a proposal pass that wrote a passing report", () => {
        describe("when the gating pass exits 0 without writing a report", () => {
            test("then it should end Errored, with the report unread", async () => {
                const outputDirectory = outputFolder();
                await runSuiteOn(
                    suiteThatWrites({
                        duringSuite: (folder) => writeReportInto(folder, PASSING_REPORT),
                    }),
                    { outputDirectory, pass: "proposal" },
                );
                const result = await runSuiteOn(suiteThatWrites({}), {
                    outputDirectory,
                    pass: "gating",
                });
                assertReadNoReport(result);
            });
        });
    });

    describe("given an empty output folder", () => {
        describe("when the suite writes a passing report", () => {
            test("then it should end Passed on that report", async () => {
                const result = await runSuiteOn(
                    suiteThatWrites({
                        duringSuite: (folder) => writeReportInto(folder, PASSING_REPORT),
                    }),
                );
                assert.equal(result.state, "Passed");
                assert.equal(evidenceMergeGateOpen(result), true);
            });
        });

        describe("when the suite exits 0 without writing a report", () => {
            test("then it should end Errored, with the report unread", async () => {
                assertReadNoReport(await runSuiteOn(suiteThatWrites({})));
            });
        });
    });
});
