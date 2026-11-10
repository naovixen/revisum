// The suite is told to record a trace of every test, so a trace the report attaches and Revisum
// cannot read is something to say out loud: it reaches the result's decode errors, with a code and
// without the text the report gave for it. A trace that reads goes into the test's finding.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WORKLOAD_OUTPUT_PATH } from "@revisum/engine";
import {
    HOSTILE_MARKER,
    evidenceModeInput,
    parsedProject,
    projectFileWithEvidence,
    recordedReport,
    specPath,
    suiteInput,
    testsOf,
    type JsonRecord,
} from "../../../engine/evidence/examples/EvidenceRun.ts";
import { withValue } from "../../../engine/plan/examples/GoldenPlan.ts";
import {
    SUPPORTED_TRACE_VERSION,
    UNKNOWN_TRACE_VERSION,
    traceArchive,
    traceLines,
    zipArchive,
} from "../../../engine/evidence/examples/ZipArchive.ts";
import { reportWithFailure } from "./examples/SuiteRun.ts";
import {
    runSuiteOn,
    suiteThatWrites,
    writeFileInto,
    writeReportInto,
} from "./support/SuiteThatWrites.ts";

const FAILED_SPEC = 1;
const TRACE_PATH = `test-results/${HOSTILE_MARKER}/trace.zip`;
const SMALL_TRACE_LIMIT = 1024;

const reportAttachingTrace = (): JsonRecord =>
    withValue(
        reportWithFailure("Error: the total is wrong"),
        [...specPath(FAILED_SPEC), "tests", 0, "results", 0, "attachments"],
        [
            {
                name: "trace",
                contentType: "application/zip",
                path: `${WORKLOAD_OUTPUT_PATH}/${TRACE_PATH}`,
            },
        ],
    );

const TOO_LARGE_ARCHIVE = zipArchive([
    { name: "trace.trace", data: traceLines(SUPPORTED_TRACE_VERSION), stored: true },
    { name: "padding", data: "x".repeat(SMALL_TRACE_LIMIT * 2), stored: true },
]);

const TRACE_PROBLEMS: readonly {
    readonly name: string;
    readonly archive: Uint8Array | null;
    readonly code: string;
    readonly limits?: JsonRecord;
}[] = [
    { name: "missing", archive: null, code: "trace-invalid" },
    {
        name: "over the size limit",
        archive: TOO_LARGE_ARCHIVE,
        code: "too-large",
        limits: { maximumTraceBytes: SMALL_TRACE_LIMIT },
    },
    {
        name: "not an archive",
        archive: new TextEncoder().encode("not a zip"),
        code: "trace-invalid",
    },
    {
        name: "of a version Revisum does not read",
        archive: traceArchive(UNKNOWN_TRACE_VERSION),
        code: "trace-unsupported",
    },
];

const runWithTrace = (archive: Uint8Array | null, limits?: JsonRecord) => {
    const report = reportAttachingTrace();
    return runSuiteOn(
        suiteThatWrites({
            exitCode: 1,
            duringSuite: (folder) => {
                writeReportInto(folder, report);
                if (archive !== null) {
                    writeFileInto(folder, TRACE_PATH, archive);
                }
            },
        }),
        {
            project: parsedProject(
                projectFileWithEvidence(evidenceModeInput([suiteInput()], limits)),
            ),
        },
    );
};

describe("Using a suite run", () => {
    for (const { name, archive, code, limits } of TRACE_PROBLEMS) {
        describe(`given a report attaching a trace that is ${name}`, () => {
            describe("when the run ends", () => {
                test(`then it should list ${code} in its decode errors`, async () => {
                    const result = await runWithTrace(archive, limits);
                    assert.deepEqual(
                        result.evidence?.decodeErrors?.map((error) => error.code),
                        [code],
                    );
                });

                test("then it should not repeat the report's path for the trace", async () => {
                    const result = await runWithTrace(archive, limits);
                    assert.ok(
                        !JSON.stringify(result.evidence?.decodeErrors ?? []).includes(
                            HOSTILE_MARKER,
                        ),
                        "a decode error repeats the path",
                    );
                });
            });
        });
    }

    describe("given a report attaching a trace that reads", () => {
        describe("when the run ends", () => {
            test("then it should list no decode errors", async () => {
                const result = await runWithTrace(traceArchive());
                assert.equal(result.evidence?.decodeErrors, undefined);
            });

            test("then it should keep the trace's actions in the test's finding", async () => {
                const result = await runWithTrace(traceArchive());
                assert.ok(
                    (result.suite?.findings[0]?.steps ?? []).some((step) =>
                        step.includes("/checkout"),
                    ),
                    JSON.stringify(result.suite?.findings),
                );
            });
        });
    });

    describe("given a report that attaches no trace", () => {
        describe("when the run ends", () => {
            test("then it should list no decode errors", async () => {
                const report = recordedReport("passing-with-criteria");
                const result = await runSuiteOn(
                    suiteThatWrites({ duringSuite: (folder) => writeReportInto(folder, report) }),
                );
                assert.equal(result.evidence?.decodeErrors, undefined);
                assert.equal(testsOf(result).length, 4);
            });
        });
    });
});
