// A run's containers and network, as a scope. What the scope starts is removed in reverse order, the
// network last, however the run ends; each removal is tried whatever the others did, and each problem
// goes to the scope's log, so a removal can never decide a run's result.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success } from "@revisum/contracts";
import {
    withContainerScope,
    type ContainerScope,
} from "../../../packages/runner/src/ContainerScope.ts";
import type { ContainerOptions } from "@revisum/runner";
import { fakeContainerEngine, type FakeEngineSettings } from "./fake-container-engine.ts";

const HOST: FakeEngineSettings = {
    localImageId: null,
    internalNetworks: true,
    probe: "blocked",
};

const RESULT = "the run's own result";
const WHY_REMOVAL_FAILED = "the container is held by the kernel";
const WHY_NETWORK_FAILED = "the network still has active endpoints";
const ACTIVE_ENDPOINTS = "has active endpoints";

const CONTAINER: ContainerOptions = {
    name: "container",
    image: "sha256:image",
    networks: [],
    user: "1000:1000",
    seccompProfile: "seccomp.json",
    workingFolder: "/",
    environment: {},
    mounts: [],
    command: ["true"],
};

type Logged = { readonly detail: string };

const scopeOptions = (logged: Logged[] = []) =>
    ({
        namePrefix: "test-run",
        networkKinds: ["internal"],
        log: (entry: Logged) => {
            logged.push(entry);
        },
    }) as const;

// Starts `count` containers in a scope with the given engine settings and returns `value`.
async function startContainers(
    settings: FakeEngineSettings,
    count: number,
    value: string = RESULT,
) {
    const engine = fakeContainerEngine(settings);
    const logged: Logged[] = [];
    let networkName = "";
    const outcome = await withContainerScope(engine, scopeOptions(logged), async (scope) => {
        networkName = scope.network;
        for (let started = 0; started < count; started += 1) {
            await scope.startContainer({ ...CONTAINER, networks: [scope.network] });
        }
        return value;
    });
    return { engine, logged, outcome, networkName };
}

describe("Using a container scope", () => {
    describe("given a run that started three containers", () => {
        describe("when the run ends", () => {
            test("then it should remove them in reverse order, the network last", async () => {
                const { engine, networkName } = await startContainers(HOST, 3);
                assert.deepEqual(engine.removals, [
                    "fake-container-3",
                    "fake-container-2",
                    "fake-container-1",
                    networkName,
                ]);
            });

            test("then it should give back the run's own result", async () => {
                const { outcome } = await startContainers(HOST, 3);
                assert.deepEqual(outcome, success(RESULT));
            });

            test("then it should leave nothing running and log nothing", async () => {
                const { engine, logged } = await startContainers(HOST, 3);
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
                assert.deepEqual(logged, []);
            });
        });
    });

    describe("given one container whose removal answers a problem", () => {
        const failingOne: FakeEngineSettings = {
            ...HOST,
            removeContainer: (containerId) =>
                Promise.resolve(
                    containerId === "fake-container-2"
                        ? failure({ detail: WHY_REMOVAL_FAILED })
                        : success(undefined),
                ),
        };

        describe("when the run ends", () => {
            test("then it should still try every other removal and the network", async () => {
                const { engine, networkName } = await startContainers(failingOne, 3);
                assert.deepEqual(engine.removals, [
                    "fake-container-3",
                    "fake-container-2",
                    "fake-container-1",
                    networkName,
                ]);
            });

            test("then it should report the problem, and the network it left held, through the scope's log", async () => {
                const { logged } = await startContainers(failingOne, 3);
                assert.equal(logged.length, 2, JSON.stringify(logged));
                assert.ok(
                    logged[0]?.detail.includes(WHY_REMOVAL_FAILED) === true,
                    JSON.stringify(logged),
                );
                assert.ok(
                    logged[1]?.detail.includes(ACTIVE_ENDPOINTS) === true,
                    JSON.stringify(logged),
                );
            });

            test("then it should keep the run's own result", async () => {
                const { outcome } = await startContainers(failingOne, 3);
                assert.deepEqual(outcome, success(RESULT));
            });
        });
    });

    describe("given an adapter whose removals reject", () => {
        const rejecting: FakeEngineSettings = {
            ...HOST,
            removeContainer: () => Promise.reject(new Error(WHY_REMOVAL_FAILED)),
            removeNetwork: () => Promise.reject(new Error(WHY_NETWORK_FAILED)),
        };

        describe("when the run ends", () => {
            test("then it should try every removal anyway", async () => {
                const { engine, networkName } = await startContainers(rejecting, 2);
                assert.deepEqual(engine.removals, [
                    "fake-container-2",
                    "fake-container-1",
                    networkName,
                ]);
            });

            test("then it should report each problem through the log", async () => {
                const { logged } = await startContainers(rejecting, 2);
                assert.equal(logged.length, 3, JSON.stringify(logged));
                assert.ok(
                    logged.some((entry) => entry.detail.includes(WHY_NETWORK_FAILED)),
                    JSON.stringify(logged),
                );
                assert.equal(
                    logged.filter((entry) => entry.detail.includes(WHY_REMOVAL_FAILED)).length,
                    2,
                    JSON.stringify(logged),
                );
            });

            test("then it should keep the run's own result", async () => {
                const { outcome } = await startContainers(rejecting, 2);
                assert.deepEqual(outcome, success(RESULT));
            });
        });
    });

    describe("given a run that throws", () => {
        describe("when the scope ends", () => {
            test("then it should remove what started and rethrow the run's error", async () => {
                const engine = fakeContainerEngine(HOST);
                const runError = new Error("the run broke");
                await assert.rejects(
                    withContainerScope(engine, scopeOptions(), async (scope) => {
                        await scope.startContainer(CONTAINER);
                        throw runError;
                    }),
                    runError,
                );
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
            });
        });
    });

    describe("given a removal the run asks for itself", () => {
        for (const { name, removeContainer } of [
            {
                name: "answers a problem",
                removeContainer: () => Promise.resolve(failure({ detail: WHY_REMOVAL_FAILED })),
            },
            {
                name: "rejects",
                removeContainer: () => Promise.reject(new Error(WHY_REMOVAL_FAILED)),
            },
        ]) {
            describe(`when the engine ${name}`, () => {
                test("then it should send the removal once and log the problem once", async () => {
                    const engine = fakeContainerEngine({ ...HOST, removeContainer });
                    const logged: Logged[] = [];
                    const answers: Awaited<ReturnType<ContainerScope["removeContainer"]>>[] = [];
                    await withContainerScope(engine, scopeOptions(logged), async (scope) => {
                        const started = await scope.startContainer({
                            ...CONTAINER,
                            networks: [scope.network],
                        });
                        assert.ok(started.ok);
                        answers.push(await scope.removeContainer(started.value));
                    });
                    const [answered] = answers;
                    assert.ok(answered !== undefined && !answered.ok, JSON.stringify(answers));
                    assert.ok(
                        answered.error.detail.includes(WHY_REMOVAL_FAILED),
                        answered.error.detail,
                    );
                    assert.equal(
                        engine.removals.filter((id) => id === "fake-container-1").length,
                        1,
                    );
                    assert.equal(logged.length, 2, JSON.stringify(logged));
                    assert.ok(
                        logged[0]?.detail.includes(WHY_REMOVAL_FAILED) === true,
                        JSON.stringify(logged),
                    );
                    assert.ok(
                        logged[1]?.detail.includes(ACTIVE_ENDPOINTS) === true,
                        JSON.stringify(logged),
                    );
                });
            });
        }

        describe("when the engine removes it", () => {
            test("then it should not be removed again when the scope ends", async () => {
                const engine = fakeContainerEngine(HOST);
                await withContainerScope(engine, scopeOptions(), async (scope) => {
                    const started = await scope.startContainer(CONTAINER);
                    assert.ok(started.ok);
                    assert.ok((await scope.removeContainer(started.value)).ok);
                });
                assert.equal(engine.removals.filter((id) => id === "fake-container-1").length, 1);
            });
        });
    });

    describe("given the network kind asked for up front", () => {
        describe("when the run's `use` starts", () => {
            test("then it should find its network already created", async () => {
                const engine = fakeContainerEngine(HOST);
                await withContainerScope(engine, scopeOptions(), (scope) => {
                    assert.deepEqual(engine.existingNetworks(), [scope.network]);
                    assert.equal(scope.networkKind, "internal");
                    return Promise.resolve();
                });
                assert.deepEqual(
                    engine.createdNetworks.map((network) => network.internal),
                    [true],
                );
            });
        });

        describe("and an engine that cannot make it", () => {
            describe("when no other kind is allowed", () => {
                test("then it should not call `use`, start nothing and give the problem", async () => {
                    const engine = fakeContainerEngine({ ...HOST, internalNetworks: false });
                    let wasUsed = false;
                    const outcome = await withContainerScope(engine, scopeOptions(), () => {
                        wasUsed = true;
                        return Promise.resolve(RESULT);
                    });
                    assert.ok(!outcome.ok, JSON.stringify(outcome));
                    assert.ok(outcome.error.detail.length > 0, JSON.stringify(outcome));
                    assert.equal(wasUsed, false);
                    assert.deepEqual(engine.started, []);
                    assert.deepEqual(engine.removals, []);
                });
            });

            describe("when an ordinary network is the next kind", () => {
                test("then it should give a scope on that network, saying which it got", async () => {
                    const engine = fakeContainerEngine({ ...HOST, internalNetworks: false });
                    const outcome = await withContainerScope(
                        engine,
                        { ...scopeOptions(), networkKinds: ["internal", "ordinary"] },
                        (scope) => Promise.resolve(scope.networkKind),
                    );
                    assert.deepEqual(outcome, success("ordinary"));
                    assert.deepEqual(
                        engine.createdNetworks.map((network) => network.internal),
                        [false],
                    );
                });
            });
        });
    });
});
