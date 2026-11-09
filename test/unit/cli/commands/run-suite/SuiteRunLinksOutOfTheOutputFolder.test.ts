// The suite controls what is in the output folder, and Revisum reads it with host rights. A link
// must not let a suite make Revisum read a file outside the folder, whether as its report or as a
// trace under a linked parent folder.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SUITE_REPORT_FILE, WORKLOAD_OUTPUT_PATH, evidenceMergeGateOpen } from "@revisum/engine";
import {
    specPath,
    testsOf,
    type JsonRecord,
} from "../../../engine/evidence/examples/EvidenceRun.ts";
import { withValue } from "../../../engine/plan/examples/GoldenPlan.ts";
import { traceArchive } from "../../../engine/evidence/examples/ZipArchive.ts";
import { reportWithFailure } from "./examples/SuiteRun.ts";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    suiteThatWrites,
    writeFileInto,
    writeReportInto,
} from "./support/SuiteThatWrites.ts";

const FAILED_SPEC = 1;
const TRACE_FILE = "trace.zip";
const LINKED_FOLDER = "linked";

const outsideFolder = (): string => mkdtempSync(join(tmpdir(), "outside-the-output-folder-"));

// Creating a link to a file needs a privilege on Windows that not every account has.
const FILE_LINKS_REFUSED = ((): string | false => {
    const folder = outsideFolder();
    try {
        writeFileSync(join(folder, "target"), "");
        symlinkSync(join(folder, "target"), join(folder, "link"), "file");
        return false;
    } catch {
        return "this operating system account may not create symbolic links to files";
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
})();

const reportAttachingTraceAt = (path: string): JsonRecord =>
    withValue(
        reportWithFailure("Error: the total is wrong"),
        [...specPath(FAILED_SPEC), "tests", 0, "results", 0, "attachments"],
        [
            {
                name: "trace",
                contentType: "application/zip",
                path: `${WORKLOAD_OUTPUT_PATH}/${path}`,
            },
        ],
    );

describe("Using a suite run", () => {
    describe("given a report that is a link to a passing report outside the output folder", () => {
        describe("when the suite exits 0", () => {
            test(
                "then it should end Errored and read none of it",
                { skip: FILE_LINKS_REFUSED },
                async () => {
                    const outside = outsideFolder();
                    writeReportInto(outside, passingReportWithNothingToReview());
                    const result = await runSuiteOn(
                        suiteThatWrites({
                            duringSuite: (folder) => {
                                symlinkSync(
                                    join(outside, SUITE_REPORT_FILE),
                                    join(folder, SUITE_REPORT_FILE),
                                    "file",
                                );
                            },
                        }),
                    );
                    assert.equal(result.state, "Errored", JSON.stringify(result.evidence));
                    assert.deepEqual(testsOf(result), []);
                    assert.equal(evidenceMergeGateOpen(result), false);
                },
            );
        });
    });

    describe("given a trace under a parent folder linked outside the output folder", () => {
        describe("when the run ends", () => {
            // A junction, which Windows lets any account create and every other system reads as a link.
            test("then it should read none of the trace and list a decode error", async () => {
                const outside = outsideFolder();
                writeFileSync(join(outside, TRACE_FILE), traceArchive());
                const report = reportAttachingTraceAt(`${LINKED_FOLDER}/${TRACE_FILE}`);
                const result = await runSuiteOn(
                    suiteThatWrites({
                        exitCode: 1,
                        duringSuite: (folder) => {
                            symlinkSync(outside, join(folder, LINKED_FOLDER), "junction");
                            writeReportInto(folder, report);
                        },
                    }),
                );
                assert.deepEqual(result.suite?.findings[0]?.steps, []);
                assert.equal(result.evidence?.decodeErrors?.length, 1);
            });
        });
    });

    describe("given a report and a trace inside the output folder", () => {
        describe("when the run ends", () => {
            test("then it should read both", async () => {
                const tracePath = `test-results/checkout/${TRACE_FILE}`;
                const report = reportAttachingTraceAt(tracePath);
                const result = await runSuiteOn(
                    suiteThatWrites({
                        exitCode: 1,
                        duringSuite: (folder) => {
                            writeReportInto(folder, report);
                            writeFileInto(folder, tracePath, traceArchive());
                        },
                    }),
                );
                assert.equal(result.state, "Failed");
                assert.ok((result.suite?.findings[0]?.steps ?? []).length > 0);
                assert.equal(result.evidence?.decodeErrors, undefined);
            });
        });
    });
});
