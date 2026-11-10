// A read the runner makes for itself, of the proxy's files or a wait for its readiness, is bounded at
// two minutes, so a wedged one still reaches the run's removal and the runner returns. Only a command
// the caller asked for runs for as long as the caller lets it.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { success, type ExecOutcome, type Result } from "@revisum/contracts";
import { dockerRunner, type EngineProblem } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { fakeContainerEngine, type FakeEngineSettings } from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";
import {
    PRESENT_IMAGES,
    errorCode,
    runnerOn,
    teamContainers,
    workloadRequest,
} from "../examples/WorkloadRequest.ts";

const READ_BOUND_MILLISECONDS = 120_000;
const PENDING = "still running";
const POLICY = egressPolicy({ allowOrigins: [] });
const IMAGE = imageDigest(PINNED_IMAGE_ID);

const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};

const FINISHED: Result<ExecOutcome, EngineProblem> = success({
    exitCode: 0,
    stdout: "",
    stderr: "",
});
const NEVER = (): Promise<Result<ExecOutcome, EngineProblem>> => new Promise(() => undefined);

const isProxyReadiness = (command: readonly string[]): boolean => command[0] === "node";
const isProxyFileRead = (command: readonly string[]): boolean => command[0] === "cat";
const isTeamCommand = (command: readonly string[]): boolean => command[0] === "npx";

const manyTurns = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

// Ticks past the read bound as many times as it takes, and says what happened, or PENDING if `running`
// has still not settled, so a wedged runner fails the test and does not hang it.
async function tickUntilSettled<Value>(
    context: TestContext,
    running: Promise<Value>,
    ticks = 6,
): Promise<Value | typeof PENDING> {
    let state: Value | typeof PENDING = PENDING;
    for (let tick = 0; tick < ticks && state === PENDING; tick += 1) {
        await manyTurns();
        context.mock.timers.tick(READ_BOUND_MILLISECONDS);
        await manyTurns();
        state = await Promise.race([running, Promise.resolve<typeof PENDING>(PENDING)]);
    }
    return state;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function isolatedRunnerOn(settings: FakeEngineSettings) {
    const engine = fakeContainerEngine(settings);
    return { engine, runner: dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT }) };
}

describe("Using the isolated runner", () => {
    describe("given a wait for the proxy that never answers", () => {
        describe("when it is still silent just before the bound", () => {
            test("then it should not have given up yet", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const wedged = deferred();
                const { runner } = isolatedRunnerOn({
                    ...ENFORCING,
                    exec: (containerId, command) => {
                        if (isProxyReadiness(command)) {
                            wedged.resolve();
                            return NEVER();
                        }
                        return Promise.resolve(FINISHED);
                    },
                });
                const running = runner.withRun(IMAGE, POLICY, () => Promise.resolve());
                await Promise.race([wedged.promise, running]);
                await manyTurns();
                context.mock.timers.tick(READ_BOUND_MILLISECONDS - 1);
                await manyTurns();
                assert.equal(await Promise.race([running, Promise.resolve(PENDING)]), PENDING);
            });
        });

        describe("when the bound passes", () => {
            test("then it should refuse the run with start-failed and remove what started", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const wedged = deferred();
                let wasUsed = false;
                const { engine, runner } = isolatedRunnerOn({
                    ...ENFORCING,
                    exec: (containerId, command) => {
                        if (isProxyReadiness(command)) {
                            wedged.resolve();
                            return NEVER();
                        }
                        return Promise.resolve(FINISHED);
                    },
                });
                const running = runner.withRun(IMAGE, POLICY, () => {
                    wasUsed = true;
                    return Promise.resolve();
                });
                await Promise.race([wedged.promise, running]);
                const state = await tickUntilSettled(context, running);
                assert.deepEqual(state, { ok: false, error: { code: "start-failed" } });
                assert.equal(wasUsed, false);
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given proxy files whose reads never answer", () => {
        describe("when a command runs and the run ends", () => {
            test("then it should keep the command's answer, fall to host and remove the containers", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const { engine, runner } = isolatedRunnerOn({
                    ...ENFORCING,
                    exec: (containerId, command) =>
                        isProxyFileRead(command) ? NEVER() : Promise.resolve(FINISHED),
                });
                const running = runner.withRun(IMAGE, POLICY, (run) => run.exec(["true"]));
                const state = await tickUntilSettled(context, running);
                assert.ok(state !== PENDING, "withRun had not returned past the bound");
                assert.ok(state.ok, JSON.stringify(state));
                assert.deepEqual(state.value.value, FINISHED);
                assert.equal(state.value.final.guaranteeLevel, "host");
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given the caller's own command that outlasts the bound", () => {
        describe("when the bound passes", () => {
            test("then it should not be cut off, and the run ends when it does", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const finished = deferred();
                const { runner } = isolatedRunnerOn({
                    ...ENFORCING,
                    exec: async (containerId, command) => {
                        if (command[0] === "long-command") {
                            await finished.promise;
                        }
                        return FINISHED;
                    },
                });
                const running = runner.withRun(IMAGE, POLICY, (run) => run.exec(["long-command"]));
                await manyTurns();
                assert.equal(await tickUntilSettled(context, running, 4), PENDING);
                finished.resolve();
                const state = await tickUntilSettled(context, running);
                assert.ok(state !== PENDING && state.ok, JSON.stringify(state));
                assert.deepEqual(state.value.value, FINISHED);
            });
        });
    });
});

describe("Using the workload runner", () => {
    const outlastingTheBoundMilliseconds = READ_BOUND_MILLISECONDS * 5;

    describe("given a wait for the proxy that never answers", () => {
        describe("when the bound passes", () => {
            test("then it should refuse with egress-unenforceable, start no team container and remove what started", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const wedged = deferred();
                const engine = fakeContainerEngine({
                    ...ENFORCING,
                    exec: (containerId, command) => {
                        if (isProxyReadiness(command)) {
                            wedged.resolve();
                            return NEVER();
                        }
                        return Promise.resolve(FINISHED);
                    },
                });
                const running = runnerOn(engine).runner.run(workloadRequest());
                await Promise.race([wedged.promise, running]);
                const state = await tickUntilSettled(context, running);
                assert.ok(state !== PENDING, "run had not returned past the bound");
                assert.equal(errorCode(state), "egress-unenforceable");
                assert.deepEqual(teamContainers(engine.started), []);
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given a command that ran and proxy files whose reads never answer", () => {
        describe("when the egress is read back", () => {
            test("then it should return the command's exit, marked unread, and remove the containers", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const engine = fakeContainerEngine({
                    ...ENFORCING,
                    exec: (containerId, command) => {
                        if (isProxyFileRead(command)) {
                            return NEVER();
                        }
                        return Promise.resolve(
                            success({
                                exitCode: isTeamCommand(command) ? 7 : 0,
                                stdout: "",
                                stderr: "",
                            }),
                        );
                    },
                });
                const running = runnerOn(engine).runner.run(workloadRequest());
                const state = await tickUntilSettled(context, running);
                assert.ok(state !== PENDING, "run had not returned past the bound");
                assert.ok(state.ok, JSON.stringify(state));
                assert.ok(state.value.kind === "exited", JSON.stringify(state));
                assert.equal(state.value.exitCode, 7);
                assert.equal(state.value.egressRecordUnread, true);
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given a command with a timeout beyond the bound on the runner's reads", () => {
        describe("when the bound passes", () => {
            test("then it should run on until its own timeout", async (context) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const engine = fakeContainerEngine({
                    ...ENFORCING,
                    exec: (containerId, command) =>
                        isTeamCommand(command) ? NEVER() : Promise.resolve(FINISHED),
                });
                const running = runnerOn(engine).runner.run(
                    workloadRequest({ timeoutMilliseconds: outlastingTheBoundMilliseconds }),
                );
                await manyTurns();
                assert.equal(await tickUntilSettled(context, running, 4), PENDING);
                const state = await tickUntilSettled(context, running, 8);
                assert.ok(state !== PENDING, "run had not returned past its timeout");
                assert.ok(state.ok, JSON.stringify(state));
                assert.equal(state.value.kind, "timed-out");
            });
        });
    });
});
