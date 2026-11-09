// An isolated run lasts as long as what `withRun` is given: the run's level is on what `use` gets
// back, and when `use` ends the run's containers go, whatever the last read of evidence does, and
// nothing can reach them through a handle kept past that point. What `withRun` gives back is `use`'s
// value and what the run finally read, read after the run's end, so a level that falls then is seen.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success, type Result, type RunnerHandle } from "@revisum/contracts";
import { dockerRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { fakeContainerEngine, type FakeEngineSettings } from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";

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

// What `withRun` gave back as `use`'s own value, with what the run finally read beside it.
const assertValue = (outcome: Result<unknown, unknown>, value: unknown): void => {
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.deepEqual(Reflect.get(Object(outcome.value), "value"), value);
};

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
                assertValue(outcome, RESULT);
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
                assertValue(outcome, failure({ detail: "the daemon lost the container" }));
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
                assertValue(outcome, success({ exitCode: 3, stdout: "out", stderr: "err" }));
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
                assertValue(outcome, RESULT);
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.equal(outcome.value.final.guaranteeLevel, "host");
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
                assertValue(outcome, RESULT);
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

    describe("given a run whose proxy files are read back at its end", () => {
        const decision = { origin: "http://outside.test", decision: "blocked" };
        const rewrite = { origin: "http://app.test", name: "heading-changed" };
        const proxyFiles: FakeEngineSettings = {
            ...ENFORCING,
            exec: (containerId, command) => {
                const path = command[1] ?? "";
                if (command[0] !== "cat") {
                    return Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" }));
                }
                if (path.includes("rewrite")) {
                    return Promise.resolve(
                        success({
                            exitCode: 0,
                            stdout: `${JSON.stringify(rewrite)}\n`,
                            stderr: "",
                        }),
                    );
                }
                if (path.includes("decision")) {
                    return Promise.resolve(
                        success({
                            exitCode: 0,
                            stdout: `${JSON.stringify(decision)}\n`,
                            stderr: "",
                        }),
                    );
                }
                return Promise.resolve(
                    success({ exitCode: 1, stdout: "", stderr: "cat: no such file\n" }),
                );
            },
        };

        describe("when the run ends", () => {
            test("then it should give back the level, decisions and rewrites read after the end", async () => {
                const { runner } = runnerOn(proxyFiles);
                let levelDuringUse = "";
                const outcome = await runner.withRun(IMAGE, POLICY, (run) => {
                    levelDuringUse = run.guaranteeLevel();
                    return Promise.resolve(RESULT);
                });
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.equal(levelDuringUse, "isolated");
                assert.deepEqual(outcome.value, {
                    value: RESULT,
                    final: {
                        guaranteeLevel: "isolated",
                        proxyDecisions: [decision],
                        rewritesApplied: [rewrite],
                    },
                });
            });
        });

        describe("and the level falls at the run's end", () => {
            describe("when the run ends", () => {
                test("then it should give back the fallen level", async () => {
                    const { runner } = runnerOn({
                        ...ENFORCING,
                        exec: (containerId, command) =>
                            Promise.resolve(
                                success(
                                    command[0] === "cat"
                                        ? { exitCode: 1, stdout: "", stderr: "cat: I/O error\n" }
                                        : { exitCode: 0, stdout: "", stderr: "" },
                                ),
                            ),
                    });
                    const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                        Promise.resolve(run.guaranteeLevel()),
                    );
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(outcome.value.value, "isolated");
                    assert.equal(outcome.value.final.guaranteeLevel, "host");
                });
            });
        });
    });

    describe("given a Docker that refuses a network with no route out", () => {
        describe("when a run is used", () => {
            test("then it should go ahead on an ordinary network at the host level", async () => {
                const { runner, logged } = runnerOn({ ...ENFORCING, internalNetworks: false });
                const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                    Promise.resolve(run.guaranteeLevel()),
                );
                assertValue(outcome, "host");
                assert.ok(
                    logged.some((entry) => entry.code === "egress-unenforceable"),
                    JSON.stringify(logged),
                );
            });
        });
    });

    describe("given a Docker that cannot make the network for another reason", () => {
        const reason = "the daemon stopped answering";
        const notARefusal: FakeEngineSettings = {
            ...ENFORCING,
            createNetwork: () => Promise.resolve(failure({ kind: "failed", detail: reason })),
        };

        describe("when a run is asked for", () => {
            test("then it should refuse with start-failed, not fall back to an ordinary network", async () => {
                const { engine, runner, logged } = runnerOn(notARefusal);
                let wasUsed = false;
                const outcome = await runner.withRun(IMAGE, POLICY, () => {
                    wasUsed = true;
                    return Promise.resolve();
                });
                assert.deepEqual(outcome, failure({ code: "start-failed" }));
                assert.equal(wasUsed, false);
                assert.equal(engine.calls.filter((call) => call === "createNetwork").length, 1);
                assert.deepEqual(engine.started, []);
                assert.ok(
                    logged.some(
                        (entry) => entry.code === "start-failed" && entry.detail.includes(reason),
                    ),
                    JSON.stringify(logged),
                );
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
                assertValue(outcome, "host");
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
