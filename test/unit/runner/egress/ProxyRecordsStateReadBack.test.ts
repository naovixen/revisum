// A run counts as isolated only as far as the proxy's records show it. A proxy that lost a record, or
// whose state file can't be read, can't show that, so the run falls to the host level. A state file
// that doesn't exist yet only means the proxy lost nothing so far.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success, type ExecOutcome } from "@revisum/contracts";
import { dockerRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { fakeContainerEngine } from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";

const POLICY = egressPolicy({ allowOrigins: ["http://app.test"] });
const RECORDS_STATE_PATH = /egress-records-state/;

const CANNOT_READ: ExecOutcome = { exitCode: 1, stdout: "", stderr: "cat: Input/output error\n" };
const NOT_WRITTEN_YET: ExecOutcome = {
    exitCode: 1,
    stdout: "",
    stderr: "cat: /tmp/egress-records-state: No such file or directory\n",
};
const RECORDS_LOST: ExecOutcome = { exitCode: 0, stdout: "lost", stderr: "" };
const NOTHING_LOST: ExecOutcome = { exitCode: 0, stdout: "", stderr: "" };

const levelAfterAnExec = async (
    stateFile: ExecOutcome,
): Promise<{ readonly level: string; readonly logged: readonly RunnerLogEntry[] }> => {
    const inner = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
    });
    const logged: RunnerLogEntry[] = [];
    const runner = dockerRunner({
        engine: {
            ...inner,
            async exec(containerId, command, environmentNames) {
                return RECORDS_STATE_PATH.test(command.join(" "))
                    ? success(stateFile)
                    : inner.exec(containerId, command, environmentNames);
            },
        },
        repositoryRoot: REPOSITORY_ROOT,
        log: (entry) => {
            logged.push(entry);
        },
    });
    let level = "not read";
    const ended = await runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, async (run) => {
        await run.exec(["true"]);
        level = run.guaranteeLevel();
    });
    assert.ok(ended.ok, JSON.stringify(ended));
    return { level, logged };
};

describe("Using a Docker runner", () => {
    for (const [what, stateFile] of [
        ["that can't be read", CANNOT_READ],
        ["that says records were lost", RECORDS_LOST],
    ] as const) {
        describe(`given a proxy records state file ${what}`, () => {
            describe("when a command has run", () => {
                test("then it should fall to the host level and log why", async () => {
                    const { level, logged } = await levelAfterAnExec(stateFile);

                    assert.equal(level, "host");
                    assert.ok(
                        logged.some((entry) => entry.code === "egress-unenforceable"),
                        JSON.stringify(logged),
                    );
                });
            });
        });
    }

    for (const [what, stateFile] of [
        ["that doesn't exist yet", NOT_WRITTEN_YET],
        ["that holds no loss", NOTHING_LOST],
    ] as const) {
        describe(`given a proxy records state file ${what}`, () => {
            describe("when a command has run", () => {
                test("then it should stay isolated", async () => {
                    const { level, logged } = await levelAfterAnExec(stateFile);

                    assert.equal(level, "isolated");
                    assert.ok(
                        !logged.some((entry) => entry.code === "egress-unenforceable"),
                        JSON.stringify(logged),
                    );
                });
            });
        });
    }
});
