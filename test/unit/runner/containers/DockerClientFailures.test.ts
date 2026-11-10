// How the Docker engine reads what the Docker client does, with no Docker: the spawn of the client is
// replaced, so each test decides what it prints and how it ends. Replacing it on the module's CommonJS
// exports and syncing the built-in ES module bindings reaches the engine's own import. The client's
// messages are the ones a real Docker 29 client printed: `docker exec` on a container that is gone
// exits 1, as a command in it may, so only the client's own words at the start of its error stream
// tell the two apart; 125 is a command's exit like any other.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, test, type TestContext } from "node:test";
import { dockerCliEngine, runDocker } from "@revisum/runner";
import { dockerAnswers, replaceSpawn, restoreDockerClient } from "../support/DockerAnswers.ts";

afterEach(restoreDockerClient);

// As a host out of file handles does: the client has no streams, and an error follows.
function dockerCannotOpenStreams(reason: string): void {
    replaceSpawn(() => {
        const child = Object.assign(new EventEmitter(), {
            stdout: null,
            stderr: null,
            kill: () => true,
        });
        setImmediate(() => child.emit("error", new Error(reason)));
        return child;
    });
}

// A client that answers nothing until it is killed, as a wedged one does.
function dockerHangsUntilKilled(): { readonly kills: () => number; finish(): void } {
    let kills = 0;
    let close: () => void = () => undefined;
    replaceSpawn(() => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => {
                kills += 1;
                setImmediate(() => child.emit("close", null, "SIGTERM"));
                return true;
            },
        });
        close = () => child.emit("close", 0, null);
        return child;
    });
    return {
        kills: () => kills,
        finish: () => {
            close();
        },
    };
}

function dockerKilledBy(signal: string): void {
    replaceSpawn(() => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => true,
        });
        setImmediate(() => child.emit("close", null, signal));
        return child;
    });
}

const manyTurns = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

const STILL_RUNNING = "still running";
const READ_BOUND_MILLISECONDS = 120_000;

const DAEMON_DOWN = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock";
const CONTAINER = "a-container";
const NO_SUCH_CONTAINER = `Error response from daemon: No such container: ${CONTAINER}\n`;
const CONTAINER_NOT_RUNNING = `Error response from daemon: container ${CONTAINER} is not running\n`;
const DAEMON_DOWN_LINUX = `${DAEMON_DOWN}. Is the docker daemon running?\n`;
const DAEMON_DOWN_WINDOWS =
    'error during connect: Get "http://127.0.0.1:1/v1.56/containers/a-container/json": dial tcp 127.0.0.1:1: connectex: No connection could be made because the target machine actively refused it.\n';
const DOCKER_API_UNREACHABLE =
    "failed to connect to the docker API at npipe:////./pipe/docker_engine; check if the path is correct and if the daemon is running: open //./pipe/docker_engine: The system cannot find the file specified.\n";

describe("Using the Docker client", () => {
    describe("given a client that cannot open its streams", () => {
        describe("when it is run", () => {
            test("then it should resolve status -1 with the reason, never reject", async () => {
                dockerCannotOpenStreams("spawn docker EMFILE");
                const outcome = await runDocker(["version"]);
                assert.equal(outcome.status, -1);
                assert.ok(outcome.stderr.includes("EMFILE"), outcome.stderr);
            });
        });
    });

    describe("given a word that spawn itself refuses", () => {
        describe("when it is run", () => {
            test("then it should resolve status -1, never reject", async () => {
                const outcome = await runDocker(["ps\0"]);
                assert.equal(outcome.status, -1);
                assert.notEqual(outcome.stderr, "");
            });
        });
    });
});

describe("Using the Docker engine", () => {
    describe("given an image the daemon holds", () => {
        describe("when its id is asked for", () => {
            test("then it should say found, with the id", async () => {
                dockerAnswers({ status: 0, stdout: "sha256:abc\n" });
                assert.deepEqual(await dockerCliEngine().imageId("run-image"), {
                    kind: "found",
                    id: "sha256:abc",
                });
            });
        });
    });

    describe("given an image the daemon does not have", () => {
        for (const stderr of [
            "Error: No such image: run-image",
            "Error response from daemon: No such image: run-image",
        ]) {
            describe(`when the client says ${stderr}`, () => {
                test("then it should say absent", async () => {
                    dockerAnswers({ status: 1, stderr });
                    assert.deepEqual(await dockerCliEngine().imageId("run-image"), {
                        kind: "absent",
                    });
                });
            });
        }
    });

    describe("given a daemon that does not answer", () => {
        describe("when an image's id is asked for", () => {
            test("then it should say unanswered, with the daemon's problem", async () => {
                dockerAnswers({ status: 1, stderr: DAEMON_DOWN });
                assert.deepEqual(await dockerCliEngine().imageId("run-image"), {
                    kind: "unanswered",
                    problem: { detail: DAEMON_DOWN },
                });
            });
        });

        describe("when the client could not run at all", () => {
            test("then it should say unanswered too", async () => {
                replaceSpawn(() => {
                    const child = Object.assign(new EventEmitter(), {
                        stdout: new EventEmitter(),
                        stderr: new EventEmitter(),
                        kill: () => true,
                    });
                    setImmediate(() => child.emit("error", new Error("spawn docker ENOENT")));
                    return child;
                });
                const found = await dockerCliEngine().imageId("run-image");
                assert.ok(found.kind === "unanswered", JSON.stringify(found));
                assert.ok(found.problem.detail.includes("ENOENT"), found.problem.detail);
            });
        });
    });

    describe("given a container the Docker client cannot reach", () => {
        for (const [name, stderr] of [
            ["is gone", NO_SUCH_CONTAINER],
            ["is not running", CONTAINER_NOT_RUNNING],
            ["sits behind a stopped daemon on Linux", DAEMON_DOWN_LINUX],
            ["sits behind a stopped daemon on Windows", DAEMON_DOWN_WINDOWS],
            ["sits behind a Docker API the client cannot reach", DOCKER_API_UNREACHABLE],
        ] as const) {
            describe(`when a command is run in one that ${name}, and the client exits 1`, () => {
                test("then it should be an engine failure with the client's message", async () => {
                    dockerAnswers({ status: 1, stderr });
                    const ran = await dockerCliEngine().exec(CONTAINER, ["true"]);
                    assert.ok(!ran.ok, JSON.stringify(ran));
                    assert.equal(ran.error.detail, stderr.trim());
                });
            });
        }
    });

    describe("given a command that ran and exited with the client's own status numbers", () => {
        for (const status of [125, 1, 137]) {
            describe(`when it exits ${status}`, () => {
                test("then it should be the command's own exit code", async () => {
                    dockerAnswers({ status, stderr: "the command's own complaint\n" });
                    const ran = await dockerCliEngine().exec(CONTAINER, ["true"]);
                    assert.ok(ran.ok, JSON.stringify(ran));
                    assert.equal(ran.value.exitCode, status);
                });
            });
        }
    });

    describe("given a command that exits 1 and prints words like the client's own", () => {
        for (const [name, stderr] of [
            ["the words without the client's prefix", `No such container: ${CONTAINER}\n`],
            [
                "the client's words about some other container",
                "Error response from daemon: No such container: other-container\n",
            ],
            [
                "the client's words part-way through its own output",
                `first line\n${NO_SUCH_CONTAINER}`,
            ],
            [
                "the daemon's words part-way through its own output",
                `first line\n${DAEMON_DOWN_LINUX}`,
            ],
        ] as const) {
            describe(`when it prints ${name}`, () => {
                test("then it should be the command's exit, not an engine failure", async () => {
                    dockerAnswers({ status: 1, stderr });
                    const ran = await dockerCliEngine().exec(CONTAINER, ["true"]);
                    assert.ok(ran.ok, JSON.stringify(ran));
                    assert.equal(ran.value.exitCode, 1);
                    assert.equal(ran.value.stderr, stderr);
                });
            });
        }
    });

    describe("given a Docker client killed by a signal", () => {
        describe("when it was running a command", () => {
            test("then it should fail naming the signal, with no invented exit code", async () => {
                dockerKilledBy("SIGKILL");
                const ran = await dockerCliEngine().exec(CONTAINER, ["true"]);
                assert.ok(!ran.ok, JSON.stringify(ran));
                assert.ok(ran.error.detail.includes("SIGKILL"), ran.error.detail);
            });
        });

        describe("when it is run directly", () => {
            test("then it should answer the signal, with no invented status", async () => {
                dockerKilledBy("SIGTERM");
                const outcome = await runDocker(["ps"]);
                assert.equal(outcome.status, null);
                assert.equal(outcome.signal, "SIGTERM");
            });
        });
    });

    describe("given a probe of the network whose client hangs", () => {
        describe("when it has hung for the bound on the runner's own reads", () => {
            test("then it should kill the client and answer reached, since an unknown is never blocked", async (context: TestContext) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const client = dockerHangsUntilKilled();
                const probing = dockerCliEngine().probeEgress(CONTAINER, [
                    { host: "1.1.1.1", port: 443 },
                ]);
                await manyTurns();
                context.mock.timers.tick(READ_BOUND_MILLISECONDS);
                await manyTurns();
                assert.ok(client.kills() > 0, "the probe's client was left running");
                assert.equal(await probing, "reached");
            });
        });
    });

    describe("given the caller's own command whose client hangs", () => {
        describe("when it has run longer than the bound on the runner's reads", () => {
            test("then it should be left running, since only its caller may end it", async (context: TestContext) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const client = dockerHangsUntilKilled();
                const running = dockerCliEngine().exec(CONTAINER, ["sleep", "3600"]);
                await manyTurns();
                context.mock.timers.tick(READ_BOUND_MILLISECONDS * 5);
                await manyTurns();
                const state = await Promise.race([running, Promise.resolve(STILL_RUNNING)]);
                assert.equal(state, STILL_RUNNING);
                assert.equal(client.kills(), 0);
                client.finish();
                await running;
            });
        });
    });

    describe("given a command that ran inside the container", () => {
        for (const status of [0, 1, 3]) {
            describe(`when it exits ${status}`, () => {
                test("then it should be the command's own exit code", async () => {
                    dockerAnswers({ status, stdout: "printed\n" });
                    const ran = await dockerCliEngine().exec("a-container", ["true"]);
                    assert.ok(ran.ok, JSON.stringify(ran));
                    assert.equal(ran.value.exitCode, status);
                    assert.equal(ran.value.stdout, "printed\n");
                });
            });
        }
    });

    describe("given a container Docker cannot remove", () => {
        describe("when it is removed", () => {
            test("then it should answer the problem", async () => {
                dockerAnswers({ status: 1, stderr: "the container is held" });
                const removed = await dockerCliEngine().removeContainer("a-container");
                assert.ok(!removed.ok, JSON.stringify(removed));
                assert.equal(removed.error.detail, "the container is held");
            });
        });
    });

    describe("given a container Docker removes", () => {
        describe("when it is removed", () => {
            test("then it should answer success", async () => {
                dockerAnswers({ status: 0 });
                assert.deepEqual(await dockerCliEngine().removeContainer("a-container"), {
                    ok: true,
                    value: undefined,
                });
            });
        });
    });

    describe("given a network Docker cannot remove", () => {
        describe("when it is removed", () => {
            test("then it should answer the problem", async () => {
                dockerAnswers({ status: 1, stderr: "the network has active endpoints" });
                const removed = await dockerCliEngine().removeNetwork("a-network");
                assert.ok(!removed.ok, JSON.stringify(removed));
                assert.equal(removed.error.detail, "the network has active endpoints");
            });
        });
    });

    describe("given a network Docker removes", () => {
        describe("when it is removed", () => {
            test("then it should answer success", async () => {
                dockerAnswers({ status: 0 });
                assert.deepEqual(await dockerCliEngine().removeNetwork("a-network"), {
                    ok: true,
                    value: undefined,
                });
            });
        });
    });
});
