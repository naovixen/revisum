// Which pass a run is decides whether it may open the merge gate, because a proposal pass runs the
// change's own tests. So a caller must say which pass it is: a run that was not told cannot assume the
// pass that opens the gate.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters, runSuite, type SuiteRunPorts } from "@revisum/cli";
import { environmentSecretStore, evidenceMergeGateOpen, type RunResult } from "@revisum/engine";
import {
    DECLARED_SECRET,
    SUITE_NAME,
    evidenceProject,
    outputFolder,
    suiteCheckout,
} from "./examples/SuiteRun.ts";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    suiteThatWrites,
    writeReportInto,
} from "./support/SuiteThatWrites.ts";

const PASSING_REPORT = passingReportWithNothingToReview();

const passingSuite = () =>
    suiteThatWrites({ duringSuite: (folder) => writeReportInto(folder, PASSING_REPORT) });

// The ports a caller gives when it leaves the pass out. Handed over through Reflect.apply, so this
// still compiles and runs once the field is required.
const portsWithoutPass = () =>
    Object.fromEntries(
        Object.entries(
            buildAdapters.suiteRunPorts({
                workload: passingSuite(),
                secrets: environmentSecretStore({
                    [DECLARED_SECRET]: "shop-api-token-for-suite-runs-0042",
                }),
                checkout: suiteCheckout(),
                outputDirectory: outputFolder(),
                pass: "gating",
            }),
        ).filter(([name]) => name !== "pass"),
    );

const isPassRequired: Pick<SuiteRunPorts, "pass"> extends Required<Pick<SuiteRunPorts, "pass">>
    ? true
    : false = true;

describe("Using a suite run", () => {
    describe("given a caller that leaves the pass out", () => {
        describe("when the passing suite ends", () => {
            test("then it should keep the merge gate shut", async () => {
                const result = (await Reflect.apply(runSuite, undefined, [
                    evidenceProject(),
                    SUITE_NAME,
                    portsWithoutPass(),
                ])) as RunResult;
                assert.equal(evidenceMergeGateOpen(result), false);
            });
        });

        describe("when its call is compiled", () => {
            test("then it should need the pass named", () => {
                assert.equal(isPassRequired, true);
            });
        });
    });

    describe("given a caller that names the proposal pass", () => {
        describe("when the passing suite ends", () => {
            test("then it should end Passed and keep the merge gate shut", async () => {
                const result = await runSuiteOn(passingSuite(), { pass: "proposal" });
                assert.equal(result.state, "Passed");
                assert.equal(evidenceMergeGateOpen(result), false);
            });
        });
    });

    describe("given a caller that names the gating pass", () => {
        describe("when the passing suite ends", () => {
            test("then it should end Passed and open the merge gate", async () => {
                const result = await runSuiteOn(passingSuite(), { pass: "gating" });
                assert.equal(result.state, "Passed");
                assert.equal(evidenceMergeGateOpen(result), true);
            });
        });
    });
});
