// An engine that throws or rejects at any call, or a log that throws, never makes a runner reject: the
// run is refused or marked down as the call's place in the run says, what started is removed, and a
// command that already ran keeps its answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success } from "@revisum/contracts";
import { dockerRunner, workloadRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import {
    BREAKAGES,
    REASON_IT_BROKE as WHY,
    commandIs,
    engineBreaking,
    type BrokenCall,
} from "../support/EngineBreaking.ts";
import {
    fakeContainerEngine,
    type FakeContainerEngine,
    type FakeEngineSettings,
} from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";
import {
    PRESENT_IMAGES,
    errorCode,
    runnerOn,
    teamContainers,
    workloadRequest,
} from "../examples/WorkloadRequest.ts";

const POLICY = egressPolicy({ allowOrigins: [] });
const IMAGE = imageDigest(PINNED_IMAGE_ID);
const LOG_BROKE = "the log broke";

const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};

const assertNothingLeft = (engine: FakeContainerEngine): void => {
    assert.deepEqual(engine.runningContainers(), [], "a container was left running");
    assert.deepEqual(engine.existingNetworks(), [], "a network was left behind");
};

const assertLoggedWhy = (logged: readonly { readonly detail: string }[]): void => {
    assert.ok(
        logged.some((entry) => entry.detail.includes(WHY)),
        JSON.stringify(logged),
    );
};

// ---- The isolated runner -------------------------------------------------------------------------

type IsolatedCase = {
    readonly name: string;
    readonly call: BrokenCall;
    readonly expected: "start-failed" | "falls-to-host" | "run-kept";
};

const ISOLATED_CASES: readonly IsolatedCase[] = [
    { name: "asking for the run image", call: { method: "imageId" }, expected: "start-failed" },
    { name: "making the network", call: { method: "createNetwork" }, expected: "start-failed" },
    { name: "starting a container", call: { method: "startContainer" }, expected: "start-failed" },
    {
        name: "waiting for the proxy",
        call: { method: "exec", isBroken: commandIs("node") },
        expected: "start-failed",
    },
    {
        name: "reading where the gateway is",
        call: { method: "networkGatewayAddress" },
        expected: "falls-to-host",
    },
    { name: "probing for a way out", call: { method: "probeEgress" }, expected: "falls-to-host" },
    {
        name: "reading the proxy's files",
        call: { method: "exec", isBroken: commandIs("cat") },
        expected: "falls-to-host",
    },
    { name: "removing a container", call: { method: "removeContainer" }, expected: "run-kept" },
    { name: "removing the network", call: { method: "removeNetwork" }, expected: "run-kept" },
];

describe("Using the isolated runner", () => {
    for (const breakage of BREAKAGES) {
        for (const { name, call, expected } of ISOLATED_CASES) {
            describe(`given an engine that ${breakage} when ${name}`, () => {
                describe("when a run is used", () => {
                    test("then it should answer without rejecting, keeping any command that ran", async () => {
                        const engine = engineBreaking(ENFORCING, call, breakage);
                        const logged: RunnerLogEntry[] = [];
                        const runner = dockerRunner({
                            engine,
                            repositoryRoot: REPOSITORY_ROOT,
                            log: (entry) => {
                                logged.push(entry);
                            },
                        });
                        const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                            run.exec(["true"]),
                        );
                        if (expected === "start-failed") {
                            assert.deepEqual(outcome, failure({ code: "start-failed" }));
                            assertLoggedWhy(logged);
                            assertNothingLeft(engine);
                            return;
                        }
                        assert.ok(outcome.ok, JSON.stringify(outcome));
                        assert.deepEqual(
                            outcome.value.value,
                            success({ exitCode: 0, stdout: "", stderr: "" }),
                        );
                        if (expected === "falls-to-host") {
                            assert.equal(outcome.value.final.guaranteeLevel, "host");
                            assertNothingLeft(engine);
                        } else {
                            assertLoggedWhy(logged);
                        }
                    });
                });
            });
        }
    }

    describe("given a log that throws", () => {
        const throwingLog = (): void => {
            throw new Error(LOG_BROKE);
        };
        const runnerWith = (settings: FakeEngineSettings) => {
            const engine = fakeContainerEngine(settings);
            return {
                engine,
                runner: dockerRunner({
                    engine,
                    repositoryRoot: REPOSITORY_ROOT,
                    log: throwingLog,
                }),
            };
        };

        describe("and a run whose last read of the proxy fails", () => {
            describe("when `use` has returned", () => {
                test("then it should keep what `use` returned and remove the containers", async () => {
                    const { engine, runner } = runnerWith({
                        ...ENFORCING,
                        exec: (containerId, command) =>
                            command[0] === "cat"
                                ? Promise.reject(new Error(WHY))
                                : Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" })),
                    });
                    const outcome = await runner.withRun(IMAGE, POLICY, () =>
                        Promise.resolve("what the run found"),
                    );
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(outcome.value.value, "what the run found");
                    assertNothingLeft(engine);
                });
            });
        });

        describe("and a run that cannot start", () => {
            describe("when it is asked for", () => {
                test("then it should still answer start-failed", async () => {
                    const { runner } = runnerWith({
                        ...ENFORCING,
                        failsToStart: () => true,
                    });
                    assert.deepEqual(
                        await runner.withRun(IMAGE, POLICY, () => Promise.resolve()),
                        failure({ code: "start-failed" }),
                    );
                });
            });
        });

        describe("and a probe that gets out", () => {
            describe("when the run starts", () => {
                test("then it should still go ahead at the host level", async () => {
                    const { runner } = runnerWith({ ...ENFORCING, probe: "reached" });
                    const outcome = await runner.withRun(IMAGE, POLICY, (run) =>
                        Promise.resolve(run.guaranteeLevel()),
                    );
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(outcome.value.value, "host");
                });
            });
        });

        describe("and a removal that fails", () => {
            describe("when the run ends", () => {
                test("then it should keep what `use` returned", async () => {
                    const { runner } = runnerWith({
                        ...ENFORCING,
                        removeContainer: () => Promise.resolve(failure({ detail: WHY })),
                    });
                    const outcome = await runner.withRun(IMAGE, POLICY, () =>
                        Promise.resolve("what the run found"),
                    );
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(outcome.value.value, "what the run found");
                });
            });
        });
    });
});

// ---- The workload runner -------------------------------------------------------------------------

type WorkloadCase = {
    readonly name: string;
    readonly call: BrokenCall;
    readonly expected: "workload-start-failed" | "egress-unenforceable" | "exit-kept" | "unread";
    // A gateway or probe that cannot be read is taken as reached, with no reason of its own to log.
    readonly isReasonLogged?: false;
};

const WORKLOAD_CASES: readonly WorkloadCase[] = [
    {
        name: "asking for an image",
        call: { method: "imageId" },
        expected: "workload-start-failed",
    },
    {
        name: "making the network",
        call: { method: "createNetwork" },
        expected: "workload-start-failed",
    },
    {
        name: "starting a container",
        call: { method: "startContainer" },
        expected: "egress-unenforceable",
    },
    {
        name: "waiting for the proxy",
        call: { method: "exec", isBroken: commandIs("node") },
        expected: "egress-unenforceable",
    },
    {
        name: "reading where the gateway is",
        call: { method: "networkGatewayAddress" },
        expected: "egress-unenforceable",
        isReasonLogged: false,
    },
    {
        name: "probing for a way out",
        call: { method: "probeEgress" },
        expected: "egress-unenforceable",
        isReasonLogged: false,
    },
    {
        name: "asking for the image's user",
        call: { method: "imageUser" },
        expected: "egress-unenforceable",
    },
    {
        name: "asking for the proxy's address",
        call: { method: "containerAddress" },
        expected: "egress-unenforceable",
    },
    {
        name: "reading the proxy's files after the command ran",
        call: { method: "exec", isBroken: commandIs("cat") },
        expected: "unread",
    },
    { name: "removing a container", call: { method: "removeContainer" }, expected: "exit-kept" },
    { name: "removing the network", call: { method: "removeNetwork" }, expected: "exit-kept" },
];

const SEVEN_THE_COMMAND_EXITED: FakeEngineSettings = {
    ...ENFORCING,
    exec: (containerId, command) =>
        Promise.resolve(
            success({ exitCode: command[0] === "npx" ? 7 : 0, stdout: "", stderr: "" }),
        ),
};

describe("Using the workload runner", () => {
    for (const breakage of BREAKAGES) {
        for (const { name, call, expected, isReasonLogged = true } of WORKLOAD_CASES) {
            describe(`given an engine that ${breakage} when ${name}`, () => {
                describe("when the request is run", () => {
                    test("then it should answer without rejecting, keeping any command that ran", async () => {
                        const engine = engineBreaking(SEVEN_THE_COMMAND_EXITED, call, breakage);
                        const { runner, logged } = runnerOn(engine);
                        const outcome = await runner.run(workloadRequest());
                        if (
                            expected === "workload-start-failed" ||
                            expected === "egress-unenforceable"
                        ) {
                            assert.equal(errorCode(outcome), expected);
                            if (isReasonLogged) {
                                assertLoggedWhy(logged);
                            }
                            assert.deepEqual(teamContainers(engine.started), []);
                            assertNothingLeft(engine);
                            return;
                        }
                        assert.ok(outcome.ok, JSON.stringify(outcome));
                        assert.ok(outcome.value.kind === "exited", JSON.stringify(outcome));
                        assert.equal(outcome.value.exitCode, 7);
                        if (expected === "unread") {
                            assert.equal(outcome.value.egressRecordUnread, true);
                            assertNothingLeft(engine);
                        } else {
                            assertLoggedWhy(logged);
                        }
                    });
                });
            });
        }
    }

    describe("given a log that throws", () => {
        const throwingLog = (): void => {
            throw new Error(LOG_BROKE);
        };
        const workloadOn = (settings: FakeEngineSettings) => {
            const engine = fakeContainerEngine(settings);
            return {
                engine,
                runner: workloadRunner({
                    engine,
                    repositoryRoot: REPOSITORY_ROOT,
                    checkout: REPOSITORY_ROOT,
                    log: throwingLog,
                }),
            };
        };

        describe("and an image that is absent", () => {
            describe("when the request is run", () => {
                test("then it should still answer the refusal", async () => {
                    const { runner } = workloadOn({ ...ENFORCING, localImageId: null, images: {} });
                    assert.equal(errorCode(await runner.run(workloadRequest())), "image-missing");
                });
            });
        });

        describe("and a command whose egress cannot be read back", () => {
            describe("when the request is run", () => {
                test("then it should keep the command's exit", async () => {
                    const { engine, runner } = workloadOn({
                        ...SEVEN_THE_COMMAND_EXITED,
                        exec: (containerId, command) =>
                            command[0] === "cat"
                                ? Promise.reject(new Error(WHY))
                                : Promise.resolve(
                                      success({
                                          exitCode: command[0] === "npx" ? 7 : 0,
                                          stdout: "",
                                          stderr: "",
                                      }),
                                  ),
                    });
                    const outcome = await runner.run(workloadRequest());
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.ok(outcome.value.kind === "exited", JSON.stringify(outcome));
                    assert.equal(outcome.value.exitCode, 7);
                    assertNothingLeft(engine);
                });
            });
        });
    });
});
