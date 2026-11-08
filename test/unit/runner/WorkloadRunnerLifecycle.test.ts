// The workload runner's edges, on a fake engine: requests refused before anything starts, an image
// that runs as root by any spelling of its user, and how a timed-out command ends, named and bounded,
// whatever Docker does while it is stopped.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import {
    failure,
    success,
    type ExecOutcome,
    type Result,
    type WorkloadOutcome,
} from "@revisum/contracts";
import type { EngineProblem } from "@revisum/runner";
import {
    ENGINE_STARTING_CALLS,
    fakeContainerEngine,
    type FakeEngineSettings,
} from "./fake-container-engine.ts";
import { PINNED_IMAGE_ID } from "./runner-examples.ts";
import {
    PRESENT_IMAGES,
    TEAM_IMAGE_ID,
    errorCode,
    printed,
    runnerOn,
    teamContainers,
    workloadRequest,
    type RequestFields,
} from "./workload-examples.ts";

const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};
const FINISHED: ExecOutcome = { exitCode: 0, stdout: "", stderr: "" };

async function runOn(settings: FakeEngineSettings, fields: RequestFields = {}) {
    const engine = fakeContainerEngine(settings);
    const { runner, logged } = runnerOn(engine);
    const outcome = await runner.run(workloadRequest(fields));
    return { engine, logged, outcome };
}

const startingCalls = (calls: readonly string[]): readonly string[] =>
    calls.filter((call) => ENGINE_STARTING_CALLS.includes(call));

// ---- Timeouts Node's timer can hold ----------------------------------------------------------------

describe("Using the workload runner", () => {
    describe("given a timeout longer than a timer can wait", () => {
        describe("when the request is run", () => {
            test("then it should refuse the request before anything starts", async () => {
                const { engine, outcome } = await runOn(ENFORCING, {
                    timeoutMilliseconds: 2_147_483_648,
                });
                assert.equal(errorCode(outcome), "workload-start-failed");
                assert.deepEqual(startingCalls(engine.calls), []);
            });
        });
    });

    describe("given the longest timeout a timer can wait", () => {
        describe("when the request is run", () => {
            test("then it should start the workload", async () => {
                const { engine, outcome } = await runOn(ENFORCING, {
                    timeoutMilliseconds: 2_147_483_647,
                });
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.equal(teamContainers(engine.started).length, 1);
            });
        });
    });

    // ---- Variable names ---------------------------------------------------------------------------------

    describe("given a declared variable whose name an environment cannot hold", () => {
        for (const name of ["BAD=NAME", "BAD NAME", ""]) {
            describe(`when the name is ${JSON.stringify(name)}`, () => {
                test("then it should refuse the request before any network, proxy or probe", async () => {
                    const { engine, outcome } = await runOn(ENFORCING, {
                        environment: [{ name, value: "a value" }],
                    });
                    assert.equal(errorCode(outcome), "workload-start-failed");
                    assert.deepEqual(startingCalls(engine.calls), []);
                });
            });
        }
    });

    // ---- Root, by any spelling ---------------------------------------------------------------------------

    const userFor = async (imageUser: string | null): Promise<string> => {
        const { engine } = await runOn({
            ...ENFORCING,
            imageUser: () => Promise.resolve(imageUser),
        });
        const [team] = teamContainers(engine.started);
        assert.ok(team !== undefined, "the team's container started");
        return team.user;
    };

    describe("given an image whose user is root however it is written", () => {
        for (const imageUser of ["root", "0", "00", "0000", "0:0", "00:00", "root:root", " 0 "]) {
            describe(`when its user is ${JSON.stringify(imageUser)}`, () => {
                test("then it should run the team's container as uid and gid 1000", async () => {
                    assert.equal(await userFor(imageUser), "1000:1000");
                });
            });
        }
    });

    describe("given an image whose user is not root", () => {
        for (const imageUser of ["node", "1000", "1000:1000", "rootless", "0a", "10"]) {
            describe(`when its user is ${JSON.stringify(imageUser)}`, () => {
                test("then it should run the team's container as that user", async () => {
                    assert.equal(await userFor(imageUser), imageUser);
                });
            });
        }
    });

    // ---- An image Docker cannot be asked about -------------------------------------------------------------

    describe("given a run image Docker cannot be asked about", () => {
        const silent: FakeEngineSettings = {
            ...ENFORCING,
            imageId: () =>
                Promise.resolve({
                    kind: "unanswered",
                    problem: { detail: "Cannot connect to the Docker daemon" },
                }),
        };

        describe("when the request is run", () => {
            test("then it should refuse with workload-start-failed, not image-missing", async () => {
                const { logged, outcome } = await runOn(silent);
                assert.equal(errorCode(outcome), "workload-start-failed");
                assert.ok(
                    logged.some((entry) => entry.detail.includes("Cannot connect")),
                    JSON.stringify(logged),
                );
            });

            test("then it should not ask the daemon again", async () => {
                const { engine } = await runOn(silent);
                assert.ok(!engine.calls.includes("daemonProblem"), JSON.stringify(engine.calls));
            });
        });
    });

    describe("given a run image that is simply absent", () => {
        describe("when the request is run", () => {
            test("then it should refuse with image-missing", async () => {
                const { engine, outcome } = await runOn({
                    ...ENFORCING,
                    localImageId: null,
                    images: {},
                });
                assert.equal(errorCode(outcome), "image-missing");
                assert.ok(!engine.calls.includes("daemonProblem"), JSON.stringify(engine.calls));
            });
        });
    });

    // ---- How a command's end is told ------------------------------------------------------------------------

    describe("given a command that finishes", () => {
        describe("when the run ends", () => {
            test("then it should say it exited, with its code and what it printed", async () => {
                const { outcome } = await runOn({
                    ...ENFORCING,
                    exec: (containerId, command) =>
                        Promise.resolve(
                            success(
                                isTeamCommand(command)
                                    ? { exitCode: 3, stdout: "printed", stderr: "" }
                                    : FINISHED,
                            ),
                        ),
                });
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.ok(outcome.value.kind === "exited", JSON.stringify(outcome));
                assert.equal(outcome.value.exitCode, 3);
                assert.equal(printed(outcome.value.stdout), "printed");
            });
        });
    });
});

// ---- A command at its timeout -------------------------------------------------------------------------

const isTeamCommand = (command: readonly string[]): boolean => command[0] === "npx";

const TIMEOUT_MILLISECONDS = 1000;
const STOP_WAIT_MILLISECONDS = 10_000;
const REMOVAL_FAILED = "the container is held by the kernel";
const PENDING = "still waiting";

const manyTurns = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

type Deferred<Value> = {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
};

function deferred<Value>(): Deferred<Value> {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

type TimedOutWorld = {
    // What the command's exec answers.
    readonly exec: () => Promise<Result<ExecOutcome, EngineProblem>>;
    // What removing the team's container answers.
    readonly removal?: () => Promise<Result<void, EngineProblem>>;
};

// Runs a command that outlives its timeout, ticking past the timeout and the bounded wait, and says
// how the run ended, or PENDING if it had not returned once the bounded wait was over.
async function runPastItsTimeout(context: TestContext, world: TimedOutWorld) {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const commandStarted = deferred<void>();
    const engine = fakeContainerEngine({
        ...ENFORCING,
        exec: (containerId, command) => {
            if (!isTeamCommand(command)) {
                return Promise.resolve(success(FINISHED));
            }
            commandStarted.resolve();
            return world.exec();
        },
        removeContainer: (id) =>
            id === teamContainerId() && world.removal !== undefined
                ? world.removal()
                : Promise.resolve(success(undefined)),
    });
    // The fake numbers its containers as they start, so the team's is the one its image was started as.
    const teamContainerId = (): string =>
        `fake-container-${engine.started.findIndex((options) => options.image === TEAM_IMAGE_ID) + 1}`;
    const { runner, logged } = runnerOn(engine);
    const running = runner.run(workloadRequest({ timeoutMilliseconds: TIMEOUT_MILLISECONDS }));
    // A run refused before its command starts must not hang the test, so either ends the wait.
    await Promise.race([commandStarted.promise, running]);
    context.mock.timers.tick(TIMEOUT_MILLISECONDS);
    await manyTurns();
    context.mock.timers.tick(STOP_WAIT_MILLISECONDS);
    await manyTurns();
    const outcome = await Promise.race([running, Promise.resolve(PENDING)]);
    return { engine, logged, outcome };
}

const assertTimedOutWith = (outcome: unknown, stop: string): WorkloadOutcome => {
    assert.ok(typeof outcome === "object" && outcome !== null, String(outcome));
    assert.notEqual(outcome, PENDING, "run() had not returned after the bounded wait");
    const reply = outcome as Result<WorkloadOutcome, string>;
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.ok(reply.value.kind === "timed-out", JSON.stringify(reply));
    assert.equal(reply.value.stop, stop);
    return reply.value;
};

const NEVER: () => Promise<Result<ExecOutcome, EngineProblem>> = () => new Promise(() => undefined);

describe("Using the workload runner at a timeout", () => {
    describe("given a command that outlives its timeout", () => {
        describe("and a removal of its container that answers a problem", () => {
            describe("when the bounded wait is over", () => {
                test("then it should return, naming the failed removal", async (context) => {
                    const { logged, outcome } = await runPastItsTimeout(context, {
                        exec: NEVER,
                        removal: () => Promise.resolve(failure({ detail: REMOVAL_FAILED })),
                    });
                    assertTimedOutWith(outcome, "removal-failed");
                    assert.ok(
                        logged.some((entry) => entry.detail.includes(REMOVAL_FAILED)),
                        JSON.stringify(logged),
                    );
                });
            });
        });

        describe("and a removal of its container that rejects", () => {
            describe("when the bounded wait is over", () => {
                test("then it should return, naming the failed removal", async (context) => {
                    const { outcome } = await runPastItsTimeout(context, {
                        exec: NEVER,
                        removal: () => Promise.reject(new Error(REMOVAL_FAILED)),
                    });
                    assertTimedOutWith(outcome, "removal-failed");
                });
            });
        });

        describe("and a removal that works but an exec that never settles", () => {
            describe("when the bounded wait is over", () => {
                test("then it should return, naming the command that never settled", async (context) => {
                    const { outcome } = await runPastItsTimeout(context, { exec: NEVER });
                    assertTimedOutWith(outcome, "command-never-settled");
                });
            });
        });

        describe("and a removal that ends the command", () => {
            describe("when it is removed", () => {
                test("then it should say it was removed, with what it printed", async (context) => {
                    const execEnds = deferred<Result<ExecOutcome, EngineProblem>>();
                    const { outcome } = await runPastItsTimeout(context, {
                        exec: () => execEnds.promise,
                        removal: () => {
                            execEnds.resolve(
                                success({ exitCode: 137, stdout: "printed before", stderr: "" }),
                            );
                            return Promise.resolve(success(undefined));
                        },
                    });
                    const ended = assertTimedOutWith(outcome, "removed");
                    assert.equal(printed(ended.stdout), "printed before");
                    assert.ok(!("exitCode" in ended), JSON.stringify(ended));
                });
            });
        });

        describe("and an exec that answers a problem once its container is removed", () => {
            describe("when it is removed", () => {
                test("then it should still say it was removed", async (context) => {
                    const execEnds = deferred<Result<ExecOutcome, EngineProblem>>();
                    const { outcome } = await runPastItsTimeout(context, {
                        exec: () => execEnds.promise,
                        removal: () => {
                            execEnds.resolve(failure({ detail: "the container went away" }));
                            return Promise.resolve(success(undefined));
                        },
                    });
                    const ended = assertTimedOutWith(outcome, "removed");
                    assert.ok(!("exitCode" in ended), JSON.stringify(ended));
                });
            });
        });
    });
});
