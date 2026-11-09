// The suite controls its output folder, so a report can vanish between Revisum finding it and reading
// it. A run ends with what it knows: the report was not there, the same as if the suite never wrote it.
import assert from "node:assert/strict";
import { realpathSync, rmSync, type PathLike } from "node:fs";
import { basename } from "node:path";
import { describe, test } from "node:test";
import { SUITE_REPORT_FILE } from "@revisum/engine";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    suiteThatWrites,
    writeReportInto,
} from "./support/SuiteThatWrites.ts";

const realPathOf = realpathSync.native;
const PASSING_REPORT = passingReportWithNothingToReview();

// Deletes the report just after its real path is looked up, as a suite still running could.
const removingTheReportOnceFound = (path: PathLike): string => {
    const real = realPathOf(path);
    if (basename(real) === SUITE_REPORT_FILE) {
        rmSync(real);
    }
    return real;
};

describe("Using a suite run", () => {
    describe("given a report that vanishes once its real path is found", () => {
        describe("when the suite ends", () => {
            test("then it should end Errored with the report missing, not reject", async (context) => {
                context.mock.method(realpathSync, "native", removingTheReportOnceFound);
                const result = await runSuiteOn(
                    suiteThatWrites({
                        duringSuite: (folder) => {
                            writeReportInto(folder, PASSING_REPORT);
                        },
                    }),
                );
                assert.equal(result.state, "Errored", JSON.stringify(result.evidence));
                assert.equal(result.evidence?.outcomeCode, "suite-report-unread");
                assert.deepEqual(
                    result.evidence.decodeErrors?.map((error) => error.code),
                    ["suite-report-missing"],
                );
            });
        });
    });
});
