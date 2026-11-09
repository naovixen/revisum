// What the Docker engine answers about images, addresses and networks, from what the Docker client
// prints: each read answers a Result, so a problem is never read as an answer. Network refusals name
// themselves: only one Docker's refusal of a network with no route out is distinct from any other failure.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { dockerCliEngine } from "@revisum/runner";
import { dockerAnswers, restoreDockerClient } from "../support/DockerAnswers.ts";

afterEach(restoreDockerClient);

const CONTAINER = "a-container";
const NETWORK = "run-network";
const NETWORKS = JSON.stringify({ [NETWORK]: { IPAddress: "172.18.0.3" } });
const NO_SUCH_CONTAINER = `Error response from daemon: No such container: ${CONTAINER}\n`;
const DAEMON_DOWN_LINUX =
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";
const DOCKER_API_UNREACHABLE =
    "failed to connect to the docker API at npipe:////./pipe/docker_engine; check if the path is correct and if the daemon is running: open //./pipe/docker_engine: The system cannot find the file specified.\n";

describe("Using the Docker engine", () => {
    describe("given an image's configured user", () => {
        for (const [stdout, user] of [
            ["node\n", "node"],
            ["\n", null],
        ] as const) {
            describe(`when Docker prints ${JSON.stringify(stdout)}`, () => {
                test("then it should answer the user, or null for none", async () => {
                    dockerAnswers({ status: 0, stdout });
                    assert.deepEqual(await dockerCliEngine().imageUser("an-image"), {
                        ok: true,
                        value: user,
                    });
                });
            });
        }
    });

    describe("given an image's user Docker cannot read", () => {
        describe("when it is asked for", () => {
            test("then it should answer the client's problem, not no user", async () => {
                dockerAnswers({ status: 1, stderr: DAEMON_DOWN_LINUX });
                const user = await dockerCliEngine().imageUser("an-image");
                assert.ok(!user.ok, JSON.stringify(user));
                assert.ok(user.error.detail.includes("Cannot connect"), user.error.detail);
            });
        });
    });

    describe("given a container's address on a network", () => {
        describe("when Docker lists an address on that network", () => {
            test("then it should answer the address", async () => {
                dockerAnswers({ status: 0, stdout: `${NETWORKS}\n` });
                assert.deepEqual(await dockerCliEngine().containerAddress(CONTAINER, NETWORK), {
                    ok: true,
                    value: "172.18.0.3",
                });
            });
        });

        for (const [name, answer] of [
            ["the client exits 1", { status: 1, stderr: NO_SUCH_CONTAINER }],
            ["the listing is not JSON", { status: 0, stdout: "not json" }],
            [
                "the container has no address on that network",
                { status: 0, stdout: JSON.stringify({ [NETWORK]: { IPAddress: "" } }) },
            ],
            [
                "the container is not on that network",
                { status: 0, stdout: JSON.stringify({ bridge: { IPAddress: "172.17.0.2" } }) },
            ],
        ] as const) {
            describe(`when ${name}`, () => {
                test("then it should answer a problem, never an address to leave out", async () => {
                    dockerAnswers(answer);
                    const address = await dockerCliEngine().containerAddress(CONTAINER, NETWORK);
                    assert.equal(address.ok, false, JSON.stringify(address));
                });
            });
        }
    });

    describe("given a network with no route out that Docker will not make", () => {
        for (const [name, answer] of [
            [
                "the daemon says the option is not one it accepts",
                {
                    status: 1,
                    stderr: 'Error response from daemon: failed to parse com.docker.network.bridge.inhibit_ipv4 value: true (strconv.ParseBool: parsing "true": invalid syntax)\n',
                },
            ],
        ] as const) {
            describe(`when ${name}`, () => {
                test("then it should name the refusal", async () => {
                    dockerAnswers(answer);
                    const created = await dockerCliEngine().createNetwork("a-network", {
                        internal: true,
                    });
                    assert.ok(!created.ok, JSON.stringify(created));
                    assert.equal(created.error.kind, "internal-refused");
                });
            });
        }
    });

    describe("given a network Docker could not make for any other reason", () => {
        for (const [name, answer] of [
            ["the daemon is down", { status: 1, stderr: DAEMON_DOWN_LINUX }],
            ["the client cannot reach the API", { status: 1, stderr: DOCKER_API_UNREACHABLE }],
            [
                "the name is taken",
                {
                    status: 1,
                    stderr: "Error response from daemon: network with name a-network already exists\n",
                },
            ],
            [
                "the address pools are used up",
                {
                    status: 1,
                    stderr: "Error response from daemon: all predefined address pools have been fully subnetted\n",
                },
            ],
        ] as const) {
            describe(`when ${name}`, () => {
                test("then it should say failed, not that the option was refused", async () => {
                    dockerAnswers(answer);
                    const created = await dockerCliEngine().createNetwork("a-network", {
                        internal: true,
                    });
                    assert.ok(!created.ok, JSON.stringify(created));
                    assert.equal(created.error.kind, "failed");
                });
            });
        }

        describe("when an ordinary network is the one Docker could not make", () => {
            test("then it should say failed", async () => {
                dockerAnswers({ status: 1, stderr: "Error response from daemon: no space left\n" });
                const created = await dockerCliEngine().createNetwork("a-network", {
                    internal: false,
                });
                assert.ok(!created.ok, JSON.stringify(created));
                assert.equal(created.error.kind, "failed");
            });
        });
    });
});
