// An earlier run's evidence must have gone before a suite starts: a leftover can't be told from what
// this run writes. Whatever removes it, a folder that is still there stops the run before any of the
// suite's code runs. The folder here really can't be removed by this user.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { RunResult } from "@revisum/engine";
import { carriesCode, outputFolder } from "./suite-run-examples.ts";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    suiteThatWrites,
    writeReportInto,
} from "./SuiteThatWrites.ts";

const RESULTS_FOLDER = "test-results";
const LEFT_BEHIND = "left-by-an-earlier-run.txt";
const EVERYONE = "*S-1-1-0";

const earlierResultsIn = (outputDirectory: string): string => {
    const results = join(outputDirectory, RESULTS_FOLDER);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, LEFT_BEHIND), "from an earlier run");
    return results;
};

// Stops this user removing anything in the folder, and gives back how to undo that.
function holdAgainstRemoval(folder: string): () => void {
    if (process.platform === "win32") {
        execFileSync("icacls", [folder, "/deny", `${EVERYONE}:(OI)(CI)(DE,DC)`], {
            windowsHide: true,
        });
        return () => {
            execFileSync("icacls", [folder, "/remove:d", EVERYONE], { windowsHide: true });
        };
    }
    chmodSync(folder, 0o555);
    return () => {
        chmodSync(folder, 0o755);
    };
}

type SuiteRunOutcome = {
    readonly result: RunResult;
    readonly hasSuiteStarted: boolean;
};

const runSuiteInto = async (outputDirectory: string): Promise<SuiteRunOutcome> => {
    let hasSuiteStarted = false;
    const result = await runSuiteOn(
        suiteThatWrites({
            duringSuite: (folder) => {
                hasSuiteStarted = true;
                writeReportInto(folder, passingReportWithNothingToReview());
            },
        }),
        { outputDirectory },
    );
    return { result, hasSuiteStarted };
};

describe("Using a suite run", () => {
    describe("given earlier results in the output folder that can't be removed", () => {
        describe("when a suite runs into that folder", () => {
            let outcome: SuiteRunOutcome;
            let allowRemoval: () => void;
            before(async () => {
                const outputDirectory = outputFolder();
                allowRemoval = holdAgainstRemoval(earlierResultsIn(outputDirectory));
                outcome = await runSuiteInto(outputDirectory);
            });
            after(() => {
                allowRemoval();
            });

            test("then it should refuse the run as workload-start-failed", () => {
                assert.equal(outcome.result.state, "Refused");
                assert.ok(
                    carriesCode(outcome.result, "workload-start-failed"),
                    JSON.stringify(outcome.result),
                );
            });

            test("then it should not start the suite", () => {
                assert.equal(outcome.hasSuiteStarted, false);
            });
        });
    });

    describe("given earlier results in the output folder that can be removed", () => {
        describe("when a suite runs into that folder", () => {
            let outcome: SuiteRunOutcome;
            let outputDirectory: string;
            before(async () => {
                outputDirectory = outputFolder();
                earlierResultsIn(outputDirectory);
                outcome = await runSuiteInto(outputDirectory);
            });

            test("then it should run the suite to its own result", () => {
                assert.equal(outcome.result.state, "Passed");
                assert.equal(outcome.hasSuiteStarted, true);
            });

            test("then it should have removed the earlier results", () => {
                assert.equal(existsSync(join(outputDirectory, RESULTS_FOLDER, LEFT_BEHIND)), false);
            });
        });
    });
});
