// What the egress proxy decided is read back from its container once the suite ends. A proxy that
// died cannot be read, and that is not the same as a proxy that blocked nothing: the run could not
// show its egress was enforced, so it cannot pass. Runs the real workload runner on a fake container
// engine, which plays the suite's part when it is asked to run the suite's command.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    WORKLOAD_OUTPUT_PATH,
    failure,
    success,
    type RunResult,
    type WorkloadRunner,
} from "@revisum/engine";
import { RUN_IMAGE_TAG, type ContainerEngine } from "@revisum/runner";
import {
    IMAGE_DIGEST,
    evidenceModeInput,
    parsedProject,
    projectFileWithEvidence,
    suiteInput,
} from "../engine/evidence-examples.ts";
import { REMOVE, withValue } from "../engine/plan-examples.ts";
import { fakeContainerEngine, type FakeContainerEngine } from "../runner/fake-container-engine.ts";
import { PINNED_IMAGE_ID } from "../runner/runner-examples.ts";
import { runnerOn } from "../runner/workload-examples.ts";
import { suiteCheckout } from "./suite-run-examples.ts";
import {
    passingReportWithNothingToReview,
    runSuiteOn,
    writeReportInto,
} from "./SuiteThatWrites.ts";

const PASSING_REPORT = passingReportWithNothingToReview();
const REPORTER_ARGUMENT = "--reporter=json";
const DECISIONS_FILE_NAME = "egress-decisions";

// One suite run with no setup command, so the only proxy read is the suite's own.
const PROJECT_WITHOUT_SETUP = parsedProject(
    projectFileWithEvidence(evidenceModeInput([withValue(suiteInput(), ["setupCommand"], REMOVE)])),
);

type ExecResult = Awaited<ReturnType<ContainerEngine["exec"]>>;

const DECISIONS_NOT_READ: readonly { readonly name: string; readonly reading: ExecResult }[] = [
    {
        name: "the engine cannot run the read",
        reading: failure({ detail: "the proxy container has gone" }),
    },
    {
        name: "the proxy container has stopped",
        reading: success({
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: container is not running",
        }),
    },
];

const DECISIONS_READ: readonly { readonly name: string; readonly reading: ExecResult }[] = [
    {
        name: "the proxy has recorded nothing yet",
        reading: success({
            exitCode: 1,
            stdout: "",
            stderr: "cat: /tmp/egress-decisions.jsonl: No such file or directory",
        }),
    },
    {
        name: "the proxy's file is empty",
        reading: success({ exitCode: 0, stdout: "", stderr: "" }),
    },
];

const folderMountedForOutput = (engine: FakeContainerEngine): string => {
    const mount = engine.started
        .flatMap((options) => options.mounts)
        .find((each) => each.target === WORKLOAD_OUTPUT_PATH);
    return mount?.source ?? assert.fail("no container mounts the output folder");
};

// A workload runner on an engine whose exec writes the passing report when it runs the suite, and
// answers a read of the proxy's decisions with `reading`.
const runnerWhoseDecisionsReadAs = (reading: ExecResult): WorkloadRunner => {
    const engine = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
        images: { [RUN_IMAGE_TAG]: PINNED_IMAGE_ID, [IMAGE_DIGEST]: IMAGE_DIGEST },
    });
    const execPlayingTheSuite: ContainerEngine["exec"] = (containerId, command) => {
        if (command.includes(REPORTER_ARGUMENT)) {
            writeReportInto(folderMountedForOutput(engine), PASSING_REPORT);
        }
        const isDecisionsRead =
            command[0] === "cat" && (command[1] ?? "").includes(DECISIONS_FILE_NAME);
        return isDecisionsRead ? Promise.resolve(reading) : engine.exec(containerId, command);
    };
    return runnerOn({ ...engine, exec: execPlayingTheSuite }, suiteCheckout()).runner;
};

const runWhereDecisionsReadAs = (reading: ExecResult): Promise<RunResult> =>
    runSuiteOn(runnerWhoseDecisionsReadAs(reading), { project: PROJECT_WITHOUT_SETUP });

describe("Using a suite run", () => {
    for (const { name, reading } of DECISIONS_NOT_READ) {
        describe(`given a proxy whose decisions cannot be read, because ${name}`, () => {
            describe("when the suite exits 0 with a passing report", () => {
                test("then it should end Errored", async () => {
                    const result = await runWhereDecisionsReadAs(reading);
                    assert.equal(result.state, "Errored", JSON.stringify(result.refusal));
                });
            });
        });
    }

    for (const { name, reading } of DECISIONS_READ) {
        describe(`given a proxy whose decisions are read, and ${name}`, () => {
            describe("when the suite exits 0 with a passing report", () => {
                test("then it should end Passed, with nothing blocked", async () => {
                    const result = await runWhereDecisionsReadAs(reading);
                    assert.equal(result.state, "Passed", JSON.stringify(result.refusal));
                    assert.deepEqual(result.blockedOrigins, []);
                });
            });
        });
    }
});
