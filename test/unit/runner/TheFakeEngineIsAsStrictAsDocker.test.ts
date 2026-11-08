// The fake answers the runner as Docker does where it matters, so a test on it can catch a runner that
// removes a network with containers on it, or runs a command in a container that has gone.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success } from "@revisum/contracts";
import { fakeRunEnding, fakeRunner } from "#test-support/fakes/FakeRunner.ts";
import { fakeRunnerHandle } from "#test-support/fakes/FakeRunnerHandle.ts";
import type { ContainerOptions } from "@revisum/runner";
import { fakeContainerEngine, type FakeEngineSettings } from "./fake-container-engine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "./runner-examples.ts";

const HOST: FakeEngineSettings = {
    localImageId: null,
    internalNetworks: true,
    probe: "blocked",
};
const NETWORK = "a-network";
const CONTAINER: ContainerOptions = {
    name: "container",
    image: "sha256:image",
    networks: [NETWORK],
    user: "1000:1000",
    seccompProfile: "seccomp.json",
    workingFolder: "/",
    environment: {},
    mounts: [],
    command: ["true"],
};

const startOne = async () => {
    const engine = fakeContainerEngine(HOST);
    await engine.createNetwork(NETWORK, { internal: true });
    const started = await engine.startContainer(CONTAINER);
    assert.ok(started.ok, JSON.stringify(started));
    return { engine, containerId: started.value };
};

describe("Using the fake container engine", () => {
    describe("given a network with a container still on it", () => {
        describe("when the network is removed", () => {
            test("then it should fail, as Docker does, and keep the network", async () => {
                const { engine } = await startOne();
                const removed = await engine.removeNetwork(NETWORK);
                assert.ok(!removed.ok, JSON.stringify(removed));
                assert.ok(removed.error.detail.includes("active endpoints"), removed.error.detail);
                assert.deepEqual(engine.existingNetworks(), [NETWORK]);
            });
        });
    });

    describe("given a container that has been removed", () => {
        describe("when a command is run in it", () => {
            test("then it should fail, as Docker does", async () => {
                const { engine, containerId } = await startOne();
                await engine.removeContainer(containerId);
                const ran = await engine.exec(containerId, ["true"]);
                assert.ok(!ran.ok, JSON.stringify(ran));
                assert.ok(ran.error.detail.includes("No such container"), ran.error.detail);
            });
        });
    });

    describe("given a container that never started", () => {
        describe("when a command is run in it", () => {
            test("then it should fail, whichever answer a test gave exec", async () => {
                const engine = fakeContainerEngine({
                    ...HOST,
                    exec: () => Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" })),
                });
                const ran = await engine.exec("never-started", ["true"]);
                assert.equal(ran.ok, false, JSON.stringify(ran));
            });
        });
    });
});

describe("Using a fake runner's handle", () => {
    describe("given a handle kept past the end of `use`", () => {
        describe("when a command is run through it", () => {
            test("then it should fail, as a real handle does", async () => {
                const kept = fakeRunnerHandle();
                const runner = fakeRunner({
                    withRun: (image, policy, use) => fakeRunEnding(kept, use),
                });
                await runner.withRun(imageDigest(PINNED_IMAGE_ID), egressPolicy({}), () =>
                    Promise.resolve(),
                );
                const answered = await kept.exec(["true"]);
                assert.equal(answered.ok, false, JSON.stringify(answered));
            });
        });
    });
});
