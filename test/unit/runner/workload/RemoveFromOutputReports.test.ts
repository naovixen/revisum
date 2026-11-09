// Removing what an earlier container of the image left in the output folder, as its own user, in a
// container of the same image with no network and only the output folder. Each step that fails is
// reported with its reason, and the container it used is gone however the removal went. Its path
// checks are the same as a workload request's; the check that it has no copy of its own is in
// WorkloadChecksHaveOneOwner.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    success,
    type ExecOutcome,
    type OutputRemoval,
    type Result,
} from "@revisum/contracts";
import type { EngineProblem } from "@revisum/runner";
import {
    fakeContainerEngine,
    type FakeContainerEngine,
    type FakeEngineSettings,
} from "../support/FakeContainerEngine.ts";
import { PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";
import {
    PRESENT_IMAGES,
    TEAM_IMAGE_ID,
    errorCode,
    outputFolder,
    runnerOn,
    teamContainers,
    workloadRequest,
} from "../examples/WorkloadRequest.ts";

const HOST: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};
const HOST_FAILURE = "EPERM from the host's own attempt";
const FINISHED: ExecOutcome = { exitCode: 0, stdout: "", stderr: "" };

const removalOf = (overrides: Partial<OutputRemoval> = {}): OutputRemoval => ({
    image: TEAM_IMAGE_ID,
    outputDirectory: outputFolder(),
    paths: ["left-over.txt"],
    hostFailure: HOST_FAILURE,
    ...overrides,
});

type ExecAnswer = (command: readonly string[]) => Promise<Result<ExecOutcome, EngineProblem>>;

const exitingZero: ExecAnswer = () => Promise.resolve(success(FINISHED));

async function removeOn(
    settings: FakeEngineSettings,
    exec: ExecAnswer = exitingZero,
    removal = removalOf(),
) {
    const engine = fakeContainerEngine({ ...settings, exec: (containerId, command) => exec(command) });
    const { runner, logged } = runnerOn(engine);
    await runner.removeFromOutput(removal);
    return { engine, logged };
}

const removerGone = (engine: FakeContainerEngine): void => {
    assert.deepEqual(
        engine.runningContainers(),
        [],
        "the container doing the removal was left running",
    );
};

const assertLogged = (logged: readonly { readonly detail: string }[], reason: string): void => {
    assert.ok(
        logged.some((entry) => entry.detail.includes(reason)),
        `${reason} was not reported in ${JSON.stringify(logged)}`,
    );
};

const commandNamed =
    (first: string, answer: Result<ExecOutcome, EngineProblem> | null): ExecAnswer =>
    (command) => {
        if (command[0] !== first) {
            return exitingZero(command);
        }
        return answer === null
            ? Promise.reject(new Error(`${first} was killed`))
            : Promise.resolve(answer);
    };

describe("Using the removal from a workload's output folder", () => {
    describe("given a host where every step works", () => {
        describe("when what the run left is removed", () => {
            test("then it should run both steps in a container with no network and remove it", async () => {
                const { engine, logged } = await removeOn(HOST);
                assert.deepEqual(
                    engine.executed.map((run) => run.command[0]),
                    ["chmod", "rm"],
                );
                assert.deepEqual(teamContainers(engine.started)[0]?.networks, []);
                removerGone(engine);
                assert.deepEqual(logged, []);
            });
        });
    });

    describe("given a host that cannot make any network", () => {
        describe("when what the run left is removed", () => {
            test("then it should still remove it, asking Docker for no network", async () => {
                const { engine, logged } = await removeOn({ ...HOST, internalNetworks: false });
                assert.ok(!engine.calls.includes("createNetwork"), JSON.stringify(engine.calls));
                assert.ok(!engine.calls.includes("removeNetwork"), JSON.stringify(engine.calls));
                assert.deepEqual(
                    engine.executed.map((run) => run.command[0]),
                    ["chmod", "rm"],
                );
                removerGone(engine);
                assert.deepEqual(logged, []);
            });
        });
    });

    describe("given an image whose user Docker cannot read", () => {
        describe("when what the run left is removed", () => {
            test("then it should report why and start nothing", async () => {
                const reason = "Docker could not answer";
                const { engine, logged } = await removeOn({
                    ...HOST,
                    imageUser: () => Promise.resolve(failure({ detail: reason })),
                });
                assertLogged(logged, reason);
                assert.deepEqual(engine.started, []);
            });
        });
    });

    describe("given a chmod the engine could not run", () => {
        describe("when what the run left is removed", () => {
            test("then it should report chmod's reason, still try rm and remove the container", async () => {
                const { engine, logged } = await removeOn(
                    HOST,
                    commandNamed("chmod", failure({ detail: "chmod could not start" })),
                );
                assertLogged(logged, "chmod could not start");
                assert.deepEqual(
                    engine.executed.map((run) => run.command[0]),
                    ["chmod", "rm"],
                );
                removerGone(engine);
            });
        });
    });

    describe("given a chmod that exits with a problem", () => {
        describe("when what the run left is removed", () => {
            test("then it should report what it printed", async () => {
                const { logged } = await removeOn(
                    HOST,
                    commandNamed(
                        "chmod",
                        success({ exitCode: 1, stdout: "", stderr: "chmod: operation refused" }),
                    ),
                );
                assertLogged(logged, "operation refused");
            });
        });
    });

    describe("given an rm that exits with a problem", () => {
        describe("when what the run left is removed", () => {
            test("then it should report what it printed and remove the container", async () => {
                const { engine, logged } = await removeOn(
                    HOST,
                    commandNamed(
                        "rm",
                        success({ exitCode: 1, stdout: "", stderr: "rm: cannot remove" }),
                    ),
                );
                assertLogged(logged, "cannot remove");
                removerGone(engine);
            });
        });
    });

    describe("given an adapter whose exec rejects", () => {
        describe("when what the run left is removed", () => {
            test("then it should report the reason and remove the container", async () => {
                const { engine, logged } = await removeOn(HOST, commandNamed("rm", null));
                assertLogged(logged, "rm was killed");
                removerGone(engine);
            });
        });
    });

    describe("given a container that cannot start", () => {
        describe("when what the run left is removed", () => {
            test("then it should report why", async () => {
                const { logged } = await removeOn({
                    ...HOST,
                    startContainer: () =>
                        Promise.resolve(failure({ detail: "the image cannot run" })),
                });
                assertLogged(logged, "the image cannot run");
            });
        });
    });

    describe("given a container that cannot be removed afterwards", () => {
        describe("when what the run left is removed", () => {
            test("then it should report why", async () => {
                const { logged } = await removeOn({
                    ...HOST,
                    removeContainer: () =>
                        Promise.resolve(failure({ detail: "the container is held" })),
                });
                assertLogged(logged, "the container is held");
            });
        });
    });

    describe("given an image Docker cannot be asked about", () => {
        describe("when what the run left is removed", () => {
            test("then it should report the problem and start nothing", async () => {
                const { engine, logged } = await removeOn({
                    ...HOST,
                    imageId: () =>
                        Promise.resolve({
                            kind: "unanswered",
                            problem: { detail: "the daemon is silent" },
                        }),
                });
                assertLogged(logged, "the daemon is silent");
                assert.deepEqual(engine.started, []);
                assert.ok(!engine.calls.includes("daemonProblem"), JSON.stringify(engine.calls));
            });
        });
    });

    describe("given an image no longer on this host", () => {
        describe("when what the run left is removed", () => {
            test("then it should report that with the host's own failure and start nothing", async () => {
                const { engine, logged } = await removeOn({
                    ...HOST,
                    imageId: () => Promise.resolve({ kind: "absent" }),
                });
                assertLogged(logged, HOST_FAILURE);
                assert.deepEqual(engine.started, []);
            });
        });
    });

    describe("given an output folder a workload request refuses", () => {
        for (const outputDirectory of [
            "relative/output",
            "/tmp/with,comma",
            '/tmp/with"quote',
            "/tmp/with=sign",
        ]) {
            describe(`when the folder is ${outputDirectory}`, () => {
                test("then it should refuse the same folder a request is refused, and start nothing", async () => {
                    const { engine, logged } = await removeOn(
                        HOST,
                        exitingZero,
                        removalOf({ outputDirectory }),
                    );
                    assert.deepEqual(engine.started, []);
                    assertLogged(logged, HOST_FAILURE);
                    const engineForRun = fakeContainerEngine(HOST);
                    const outcome = await runnerOn(engineForRun).runner.run(
                        workloadRequest({ outputDirectory }),
                    );
                    assert.equal(errorCode(outcome), "workload-start-failed");
                    assert.deepEqual(engineForRun.started, []);
                });
            });
        }
    });
});
