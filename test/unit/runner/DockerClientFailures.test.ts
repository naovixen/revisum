// How the Docker engine reads what the Docker client does, with no Docker: the spawn of the client is
// replaced, so each test decides what it prints and how it ends. Replacing it on the module's CommonJS
// exports and syncing the built-in ES module bindings reaches the engine's own import.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, test } from "node:test";
import { dockerCliEngine, runDocker } from "@revisum/runner";

const childProcess: object = createRequire(import.meta.url)("node:child_process");
const realSpawn: unknown = Reflect.get(childProcess, "spawn");

afterEach(() => {
    Reflect.set(childProcess, "spawn", realSpawn);
    syncBuiltinESMExports();
});

type DockerAnswer = { readonly status: number; readonly stdout?: string; readonly stderr?: string };

const replaceSpawn = (answerWith: () => unknown): void => {
    Reflect.set(childProcess, "spawn", answerWith);
    syncBuiltinESMExports();
};

function dockerAnswers(answer: DockerAnswer): void {
    replaceSpawn(() => {
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true });
        setImmediate(() => {
            stdout.emit("data", Buffer.from(answer.stdout ?? "", "utf8"));
            stderr.emit("data", Buffer.from(answer.stderr ?? "", "utf8"));
            child.emit("close", answer.status);
        });
        return child;
    });
}

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

const DAEMON_DOWN = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock";

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

    describe("given a command that Docker's own daemon failed", () => {
        describe("when it is run through exec and docker itself exits 125", () => {
            test("then it should be an engine failure with the daemon's message", async () => {
                dockerAnswers({
                    status: 125,
                    stderr: "Error response from daemon: container is not running",
                });
                const ran = await dockerCliEngine().exec("a-container", ["true"]);
                assert.ok(!ran.ok, JSON.stringify(ran));
                assert.ok(ran.error.detail.includes("not running"), ran.error.detail);
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
