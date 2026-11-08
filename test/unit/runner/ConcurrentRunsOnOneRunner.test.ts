// One runner can hold several runs at once, and each must keep its own guarantee level: a run that
// could not enforce egress must not read as isolated because another run started after it, and a run
// that stays isolated must not lose that because another lost its proxy's records.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { success, type Runner, type RunnerHandle } from "@revisum/contracts";
import { dockerRunner, type ContainerEngine } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import { fakeContainerEngine } from "./fake-container-engine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "./runner-examples.ts";

const POLICY = egressPolicy({ allowOrigins: ["http://app.test"] });
const NO_LEVEL_OF_ITS_OWN = "no level of its own";
const PROXY_NAME_ENDING = "-proxy";

type EngineSettings = {
    // What each run's probe finds, in the order the runs start.
    readonly probes: readonly ("reached" | "blocked")[];
};

type EngineWithUnreadableProxy = ContainerEngine & {
    // From now on, the given run's proxy files can't be read. Runs count from 0, as they started.
    stopReadingProxyOf(runIndex: number): void;
};

function engineFor({ probes }: EngineSettings): EngineWithUnreadableProxy {
    const inner = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
    });
    const remainingProbes = [...probes];
    const proxyIds: string[] = [];
    const unreadableProxies = new Set<string>();
    return {
        ...inner,
        probeEgress: () => Promise.resolve(remainingProbes.shift() ?? "blocked"),
        async startContainer(options) {
            const started = await inner.startContainer(options);
            if (started.ok && options.name.endsWith(PROXY_NAME_ENDING)) {
                proxyIds.push(started.value);
            }
            return started;
        },
        exec(containerId, command, environmentNames) {
            return unreadableProxies.has(containerId)
                ? Promise.resolve(
                      success({
                          exitCode: 1,
                          stdout: "",
                          stderr: "cat: /tmp/proxy-file.jsonl: Input/output error\n",
                      }),
                  )
                : inner.exec(containerId, command, environmentNames);
        },
        stopReadingProxyOf(runIndex) {
            const proxyId = proxyIds[runIndex];
            assert.ok(proxyId !== undefined, `run ${runIndex} has no proxy`);
            unreadableProxies.add(proxyId);
        },
    };
}

// A run's own level, read from its handle. Only a handle can say which run it means.
function levelOfRun(handle: RunnerHandle): unknown {
    const read: unknown = Reflect.get(handle, "guaranteeLevel");
    return typeof read === "function" ? Reflect.apply(read, handle, []) : NO_LEVEL_OF_ITS_OWN;
}

type TwoLevels = { readonly first: unknown; readonly second: unknown };

// Both runs held open at once, the second started while the first is up, with `body` run inside both.
async function levelsOfTwoRuns(
    runner: Runner,
    body: (first: RunnerHandle, second: RunnerHandle) => Promise<void> = () => Promise.resolve(),
): Promise<TwoLevels> {
    const outer = await runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, (first) =>
        runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, async (second) => {
            await body(first, second);
            return { first: levelOfRun(first), second: levelOfRun(second) };
        }),
    );
    assert.ok(outer.ok, JSON.stringify(outer));
    assert.ok(outer.value.value.ok, JSON.stringify(outer));
    return outer.value.value.value.value;
}

const runnerOn = (engine: ContainerEngine): Runner =>
    dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT });

describe("Using the isolated runner", () => {
    describe("given a run that could not enforce egress, and a later run that could", () => {
        describe("when both are running on one runner", () => {
            let levels: TwoLevels;
            before(async () => {
                levels = await levelsOfTwoRuns(
                    runnerOn(engineFor({ probes: ["reached", "blocked"] })),
                );
            });

            test("then it should keep the first run at the host level", () => {
                assert.equal(levels.first, "host");
            });

            test("then it should give the later run the isolated level", () => {
                assert.equal(levels.second, "isolated");
            });
        });
    });

    describe("given a run that enforced egress, and a later run that could not", () => {
        describe("when both are running on one runner", () => {
            let levels: TwoLevels;
            before(async () => {
                levels = await levelsOfTwoRuns(
                    runnerOn(engineFor({ probes: ["blocked", "reached"] })),
                );
            });

            test("then it should keep the first run at the isolated level", () => {
                assert.equal(levels.first, "isolated");
            });

            test("then it should give the later run the host level", () => {
                assert.equal(levels.second, "host");
            });
        });
    });

    describe("given two isolated runs on one runner", () => {
        describe("when what the first run's proxy decided can no longer be read", () => {
            let levels: TwoLevels;
            before(async () => {
                const engine = engineFor({ probes: ["blocked", "blocked"] });
                levels = await levelsOfTwoRuns(runnerOn(engine), async (first) => {
                    engine.stopReadingProxyOf(0);
                    await first.exec(["true"]);
                });
            });

            test("then it should take the first run down to the host level", () => {
                assert.equal(levels.first, "host");
            });

            test("then it should leave the second run at the isolated level", () => {
                assert.equal(levels.second, "isolated");
            });
        });

        describe("when both proxies can still be read", () => {
            test("then it should keep both runs at the isolated level", async () => {
                const levels = await levelsOfTwoRuns(
                    runnerOn(engineFor({ probes: ["blocked", "blocked"] })),
                    async (first) => {
                        await first.exec(["true"]);
                    },
                );
                assert.deepEqual(levels, { first: "isolated", second: "isolated" });
            });
        });
    });
});
