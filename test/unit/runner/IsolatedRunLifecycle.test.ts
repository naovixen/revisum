// An isolated run lasts as long as what `withRun` is given: the run's level is on what `use` gets
// back, and when `use` ends the run's containers go, whatever the last read of evidence does, and
// nothing can reach them through a handle kept past that point.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success, type RunnerHandle } from "@revisum/contracts";
import { dockerRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import { fakeContainerEngine, type FakeEngineSettings } from "./fake-container-engine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "./runner-examples.ts";

const POLICY = egressPolicy({ allowOrigins: [] });
const IMAGE = imageDigest(PINNED_IMAGE_ID);
const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
};
const RESULT = "what the run found";
const WHY_THE_LAST_READ_FAILED = "the proxy's files could not be read back";
const SILENT = "Cannot connect to the Docker daemon";

const isBrokenCommand = (command: readonly string[]): boolean => command[0] === "broken-command";

function runnerOn(settings: FakeEngineSettings) {
    const engine = fakeContainerEngine(settings);
    const logged: RunnerLogEntry[] = [];
    const runner = dockerRunner({
        engine,
        repositoryRoot: REPOSITORY_ROOT,
        log: (entry) => {
            logged.push(entry);
        },
    });
    return { engine, runner, logged };
}

describe("Using an isolated run", () => {
    describe("given a host that enforces egress", () => {
        describe("when a run is used", () => {
            test("then it should hand `use` a run at the isolated level and give back what `use` returned", async () => {
                const { runner } = runnerOn(ENFORCING);
                let level = "";
                const outcome = await runner.withRun(IMAGE, POLICY, (run) => {
                    level = run.guaranteeLevel();
                    return Promise.resolve(RESULT);
                });
                assert.deepEqual(outcome, success(RESULT));
                assert.equal(level, "isolated");
            });

            test("then it should remove the run's containers and network once `use` ends", async () => {
                const { engine, runner } = runnerOn(ENFORCING);
                await runner.withRun(IMAGE, POLICY, () => Promise.resolve());
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });

        describe("when a command in the run fails to start in the engine", () => {
            test("then it should answer the engine's problem as a failure from exec", async () => {
                const { runner } = runnerOn({
                    ...ENFORCING,
                    exec: (containerId, command) =>
                        Promise.resolve(
                            isBrokenCommand(command)
                                ? failure({ detail: "the daemon lost the container" })
                                : success({ exitCode: 0, stdout: "", stderr: "" }),
                        ),
                });
                const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                    run.exec(["broken-command"]),
                );
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.deepEqual(
                    outcome.value,
                    failure({ detail: "the daemon lost the container" }),
                );
            });
        });

        describe("when a command in the run ends with an exit code", () => {
            test("then it should answer that code from exec", async () => {
                const { runner } = runnerOn({
                    ...ENFORCING,
                    exec: (containerId, command) =>
                        Promise.resolve(
                            success(
                                isBrokenCommand(command)
                                    ? { exitCode: 3, stdout: "out", stderr: "err" }
                                    : { exitCode: 0, stdout: "", stderr: "" },
                            ),
                        ),
                });
                const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                    run.exec(["broken-command"]),
                );
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.deepEqual(
                    outcome.value,
                    success({ exitCode: 3, stdout: "out", stderr: "err" }),
                );
            });
        });

        describe("when `use` has ended and a handle is kept past it", () => {
            test("then it should answer a failure from exec and reach no container", async () => {
                const { engine, runner } = runnerOn(ENFORCING);
                const kept: RunnerHandle[] = [];
                await runner.withRun(IMAGE, POLICY, (run) => {
                    kept.push(run);
                    return Promise.resolve();
                });
                const [run] = kept;
                assert.ok(run !== undefined);
                const before = engine.executed.length;
                const answered = await run.exec(["true"]);
                assert.ok(!answered.ok, JSON.stringify(answered));
                assert.equal(engine.executed.length, before);
            });
        });

        describe("when the last read of the proxy's evidence rejects", () => {
            const lastReadRejects: FakeEngineSettings = {
                ...ENFORCING,
                exec: (containerId, command) =>
                    command[0] === "cat"
                        ? Promise.reject(new Error(WHY_THE_LAST_READ_FAILED))
                        : Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" })),
            };

            test("then it should still remove the run's containers and network", async () => {
                const { engine, runner } = runnerOn(lastReadRejects);
                await runner.withRun(IMAGE, POLICY, () => Promise.resolve());
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });

            test("then it should keep what `use` returned and take the run to the host level", async () => {
                const { runner } = runnerOn(lastReadRejects);
                const kept: RunnerHandle[] = [];
                const outcome = await runner.withRun(IMAGE, POLICY, (run) => {
                    kept.push(run);
                    return Promise.resolve(RESULT);
                });
                assert.deepEqual(outcome, success(RESULT));
                assert.equal(kept[0]?.guaranteeLevel(), "host");
            });
        });

        describe("when a removal fails after the run", () => {
            test("then it should report it through the run's log and keep what `use` returned", async () => {
                const reason = "the container is held";
                const { runner, logged } = runnerOn({
                    ...ENFORCING,
                    removeContainer: () => Promise.resolve(failure({ detail: reason })),
                });
                const outcome = await runner.withRun(IMAGE, POLICY, () => Promise.resolve(RESULT));
                assert.deepEqual(outcome, success(RESULT));
                assert.ok(
                    logged.some((entry) => entry.detail.includes(reason)),
                    JSON.stringify(logged),
                );
            });
        });

        describe("when `use` throws", () => {
            test("then it should remove the run's containers and rethrow", async () => {
                const { engine, runner } = runnerOn(ENFORCING);
                const thrown = new Error("the run's own failure");
                await assert.rejects(
                    runner.withRun(IMAGE, POLICY, () => Promise.reject(thrown)),
                    thrown,
                );
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given a host where a probe gets out", () => {
        describe("when a run is used", () => {
            test("then it should hand `use` a run at the host level", async () => {
                const { runner } = runnerOn({ ...ENFORCING, probe: "reached" });
                const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                    Promise.resolve(run.guaranteeLevel()),
                );
                assert.deepEqual(outcome, success("host"));
            });
        });
    });

    describe("given a run image Docker cannot be asked about", () => {
        const silent: FakeEngineSettings = {
            ...ENFORCING,
            imageId: () => Promise.resolve({ kind: "unanswered", problem: { detail: SILENT } }),
        };

        describe("when a run is asked for", () => {
            test("then it should refuse with start-failed, not call `use` and start nothing", async () => {
                const { engine, runner, logged } = runnerOn(silent);
                let wasUsed = false;
                const outcome = await runner.withRun(IMAGE, POLICY, () => {
                    wasUsed = true;
                    return Promise.resolve();
                });
                assert.deepEqual(outcome, failure({ code: "start-failed" }));
                assert.equal(wasUsed, false);
                assert.deepEqual(engine.started, []);
                assert.ok(
                    logged.some((entry) => entry.detail.includes(SILENT)),
                    JSON.stringify(logged),
                );
            });

            test("then it should not ask the daemon again", async () => {
                const { engine, runner } = runnerOn(silent);
                await runner.withRun(IMAGE, POLICY, () => Promise.resolve());
                assert.ok(!engine.calls.includes("daemonProblem"), JSON.stringify(engine.calls));
            });
        });
    });

    describe("given a run image that is simply absent", () => {
        describe("when a run is asked for", () => {
            test("then it should refuse with image-missing, without asking the daemon again", async () => {
                const { engine, runner } = runnerOn({ ...ENFORCING, localImageId: null });
                const outcome = await runner.withRun(IMAGE, POLICY, () => Promise.resolve());
                assert.deepEqual(outcome, failure({ code: "image-missing" }));
                assert.ok(!engine.calls.includes("daemonProblem"), JSON.stringify(engine.calls));
            });
        });
    });
});
