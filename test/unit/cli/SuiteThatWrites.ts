// A suite run on a fake workload runner that plays a suite's part as a real one would: its files
// appear in the output folder while the command runs, not before. The pass is always named, so a
// test here never depends on what a run does when the caller leaves it out.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildAdapters, runSuite } from "@revisum/cli";
import {
    SUITE_REPORT_FILE,
    environmentSecretStore,
    success,
    type Project,
    type RunResult,
    type SuitePass,
    type WorkloadOutcome,
    type WorkloadRunner,
} from "@revisum/engine";
import { recordedReport, type JsonRecord, specPath } from "../engine/evidence-examples.ts";
import { withValue } from "../engine/plan-examples.ts";
import {
    DECLARED_SECRET,
    SUITE_NAME,
    evidenceProject,
    isSuiteRequest,
    outputFolder,
    suiteCheckout,
} from "./suite-run-examples.ts";
import { fakeWorkloadRunner } from "#test-support/fakes/FakeWorkloadRunner.ts";

// The recorded passing report with its two malformed criterion annotations left out: they would
// raise a review item, which keeps the merge gate shut for a reason of its own.
export const passingReportWithNothingToReview = (): JsonRecord =>
    withValue(
        recordedReport("passing-with-criteria"),
        [...specPath(1), "tests", 0, "annotations"],
        [],
    );

export type WrittenSuite = {
    // Each runs with the output folder the runner was told to use.
    readonly duringSetup?: (folder: string) => void;
    readonly duringSuite?: (folder: string) => void;
    readonly exitCode?: number;
    readonly timedOut?: boolean;
};

const nothingPrinted = () => ({ bytes: new Uint8Array(), truncated: false });

export function suiteThatWrites(suite: WrittenSuite): WorkloadRunner {
    return fakeWorkloadRunner(
        {
            run(request) {
                mkdirSync(request.outputDirectory, { recursive: true });
                const isSuite = isSuiteRequest(request);
                (isSuite ? suite.duringSuite : suite.duringSetup)?.(request.outputDirectory);
                const records = {
                    egressEvents: [],
                    stdout: nothingPrinted(),
                    stderr: nothingPrinted(),
                };
                const outcome: WorkloadOutcome =
                    isSuite && suite.timedOut === true
                        ? { kind: "timed-out", stop: "removed", ...records }
                        : { kind: "exited", exitCode: isSuite ? (suite.exitCode ?? 0) : 0, ...records };
                return Promise.resolve(success(outcome));
            },
        },
    );
}

export const writeReportInto = (folder: string, report: unknown): void => {
    writeFileSync(join(folder, SUITE_REPORT_FILE), JSON.stringify(report));
};

export const writeFileInto = (folder: string, path: string, data: Uint8Array): void => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), data);
};

export type WrittenRunOptions = {
    readonly project?: Project;
    readonly pass?: SuitePass;
    readonly outputDirectory?: string;
};

export const runSuiteOn = (
    workload: WorkloadRunner,
    options: WrittenRunOptions = {},
): Promise<RunResult> =>
    runSuite(
        options.project ?? evidenceProject(),
        SUITE_NAME,
        buildAdapters.suiteRunPorts({
            workload,
            secrets: environmentSecretStore({
                [DECLARED_SECRET]: "shop-api-token-for-suite-runs-0042",
            }),
            checkout: suiteCheckout(),
            outputDirectory: options.outputDirectory ?? outputFolder(),
            pass: options.pass ?? "gating",
        }),
    );
