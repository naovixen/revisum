// A scope asked for no network, a network kind tried only after a refusal, and a removal still in
// flight when the run ends: the scope settles it, under a bound, before removing the network.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { failure, success } from "@revisum/contracts";
import { withContainerScope } from "../../../../packages/runner/src/containers/ContainerScope.ts";
import type { ContainerOptions } from "@revisum/runner";
import { fakeContainerEngine, type FakeEngineSettings } from "../support/FakeContainerEngine.ts";

const HOST: FakeEngineSettings = {
    localImageId: null,
    internalNetworks: true,
    probe: "blocked",
};

const RESULT = "the run's own result";
const REASON = "the daemon stopped answering";
const NO_NETWORK = { namePrefix: "test-run", networkKinds: [], log: () => undefined } as const;
const TICKS_TO_GIVE = 10;
const TICK_MILLISECONDS = 120_000;
const PENDING = "still running";

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

describe("Using a container scope", () => {
    describe("given a run that asks for no network", () => {
        describe("when it starts a container and ends", () => {
            test("then it should ask Docker for no network, and remove the container", async () => {
                const engine = fakeContainerEngine(HOST);
                const outcome = await withContainerScope(engine, NO_NETWORK, async (scope) => {
                    const started = await scope.startContainer(CONTAINER);
                    return started.ok;
                });
                assert.deepEqual(outcome, success(true));
                assert.ok(!engine.calls.includes("createNetwork"), JSON.stringify(engine.calls));
                assert.ok(!engine.calls.includes("removeNetwork"), JSON.stringify(engine.calls));
                assert.deepEqual(engine.runningContainers(), []);
            });
        });

        describe("and a Docker that refuses every network", () => {
            describe("when the run starts", () => {
                test("then it should still call `use`", async () => {
                    const engine = fakeContainerEngine({ ...HOST, internalNetworks: false });
                    let wasUsed = false;
                    const outcome = await withContainerScope(engine, NO_NETWORK, () => {
                        wasUsed = true;
                        return Promise.resolve(RESULT);
                    });
                    assert.deepEqual(outcome, success(RESULT));
                    assert.equal(wasUsed, true);
                });
            });
        });
    });

    describe("given an internal network that fails for a reason other than a refusal", () => {
        const notARefusal: FakeEngineSettings = {
            ...HOST,
            createNetwork: () => Promise.resolve(failure({ kind: "failed", detail: REASON })),
        };

        describe("when an ordinary network is the next kind", () => {
            test("then it should not try the ordinary network, nor call `use`", async () => {
                const engine = fakeContainerEngine(notARefusal);
                let wasUsed = false;
                const outcome = await withContainerScope(
                    engine,
                    { ...scopeOptions(), networkKinds: ["internal", "ordinary"] },
                    () => {
                        wasUsed = true;
                        return Promise.resolve(RESULT);
                    },
                );
                assert.ok(!outcome.ok, JSON.stringify(outcome));
                assert.ok(outcome.error.detail.includes(REASON), outcome.error.detail);
                assert.equal(wasUsed, false);
                assert.equal(engine.calls.filter((call) => call === "createNetwork").length, 1);
            });
        });
    });

    describe("given an engine that throws creating a network", () => {
        describe("when an ordinary network is the next kind", () => {
            test("then it should not take the throw for a refusal", async () => {
                const engine = fakeContainerEngine({
                    ...HOST,
                    createNetwork: () => Promise.reject(new Error("the client broke")),
                });
                const outcome = await withContainerScope(
                    engine,
                    { ...scopeOptions(), networkKinds: ["internal", "ordinary"] },
                    () => Promise.resolve(RESULT),
                );
                assert.equal(outcome.ok, false, JSON.stringify(outcome));
                assert.equal(engine.calls.filter((call) => call === "createNetwork").length, 1);
            });
        });
    });

    describe("given a removal the run sent that has not answered when the run ends", () => {
        const manyTurns = async (): Promise<void> => {
            for (let turn = 0; turn < 10; turn += 1) {
                await new Promise((resolve) => {
                    setImmediate(resolve);
                });
            }
        };

        const lateRemoval = () => {
            let answer: () => void = () => undefined;
            const answered = new Promise<ReturnType<typeof success<undefined>>>((resolve) => {
                answer = () => {
                    resolve(success(undefined));
                };
            });
            return { answered, answer: () => answer() };
        };

        describe("when the removal answers late", () => {
            test("then it should remove the network only after it, with the container gone first", async () => {
                const removal = lateRemoval();
                const engine = fakeContainerEngine({
                    ...HOST,
                    removeContainer: (containerId) =>
                        containerId === "fake-container-1"
                            ? removal.answered
                            : Promise.resolve(success(undefined)),
                });
                const logged: Logged[] = [];
                const running = withContainerScope(engine, scopeOptions(logged), async (scope) => {
                    const started = await scope.startContainer(CONTAINER);
                    assert.ok(started.ok);
                    void scope.removeContainer(started.value);
                });
                await manyTurns();
                assert.ok(!engine.calls.includes("removeNetwork"), JSON.stringify(engine.calls));
                assert.deepEqual(engine.runningContainers(), ["fake-container-1"]);
                removal.answer();
                await running;
                assert.deepEqual(engine.runningContainers(), []);
                assert.deepEqual(engine.existingNetworks(), []);
                assert.deepEqual(logged, []);
            });
        });

        describe("when the removal never answers", () => {
            const neverAnswers: FakeEngineSettings = {
                ...HOST,
                removeContainer: () => new Promise(() => undefined),
            };

            test("then it should still end, within its bound, and report it", async (context: TestContext) => {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const engine = fakeContainerEngine(neverAnswers);
                const logged: Logged[] = [];
                const running = withContainerScope(engine, scopeOptions(logged), async (scope) => {
                    const started = await scope.startContainer(CONTAINER);
                    assert.ok(started.ok);
                    void scope.removeContainer(started.value);
                    return RESULT;
                });
                let state: unknown = PENDING;
                for (let tick = 0; tick < TICKS_TO_GIVE && state === PENDING; tick += 1) {
                    await manyTurns();
                    context.mock.timers.tick(TICK_MILLISECONDS);
                    await manyTurns();
                    state = await Promise.race([running, Promise.resolve(PENDING)]);
                }
                assert.deepEqual(state, success(RESULT));
                assert.ok(engine.calls.includes("removeNetwork"), JSON.stringify(engine.calls));
                assert.ok(
                    logged.some((entry) => entry.detail.includes("fake-container-1")),
                    JSON.stringify(logged),
                );
            });
        });
    });
});
