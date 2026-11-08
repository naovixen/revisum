// What the workload runner does with what an engine says about images, addresses and networks: a
// problem refuses the team's run and is never taken for an answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success } from "@revisum/contracts";
import { fakeContainerEngine, type FakeEngineSettings } from "./fake-container-engine.ts";
import { PINNED_IMAGE_ID } from "./runner-examples.ts";
import {
    PRESENT_IMAGES,
    errorCode,
    runnerOn,
    teamContainers,
    workloadRequest,
} from "./workload-examples.ts";

const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};

async function runOn(settings: FakeEngineSettings) {
    const engine = fakeContainerEngine(settings);
    const { runner, logged } = runnerOn(engine);
    const outcome = await runner.run(workloadRequest());
    return { engine, logged, outcome };
}

const REASON = "the daemon stopped answering";

// ---- The image's user and the proxy's address -------------------------------------------------------

const WHY_THE_READ_FAILED = "Docker could not answer";
const THE_PROXY_ADDRESS = "172.18.0.9";

describe("Using the workload runner on a Docker that answers nothing about its containers", () => {
    for (const [name, settings] of [
        [
            "the image's user cannot be read",
            { imageUser: () => Promise.resolve(failure({ detail: WHY_THE_READ_FAILED })) },
        ],
        [
            "the proxy's address cannot be read",
            { containerAddress: () => Promise.resolve(failure({ detail: WHY_THE_READ_FAILED })) },
        ],
    ] as const) {
        describe(`given that ${name}`, () => {
            describe("when the request is run", () => {
                test("then it should refuse with egress-unenforceable and never start the team's container", async () => {
                    const { engine, logged, outcome } = await runOn({ ...ENFORCING, ...settings });
                    assert.equal(errorCode(outcome), "egress-unenforceable");
                    assert.deepEqual(teamContainers(engine.started), []);
                    assert.ok(
                        logged.some(
                            (entry) =>
                                entry.code === "egress-unenforceable" &&
                                entry.detail.includes(WHY_THE_READ_FAILED),
                        ),
                        JSON.stringify(logged),
                    );
                    assert.deepEqual(engine.runningContainers(), []);
                    assert.deepEqual(engine.existingNetworks(), []);
                });
            });
        });
    }

    describe("given a proxy whose address can be read", () => {
        describe("when the team's container starts", () => {
            test("then it should send the container's lookups to that address", async () => {
                const { engine, outcome } = await runOn({
                    ...ENFORCING,
                    containerAddress: () => Promise.resolve(success(THE_PROXY_ADDRESS)),
                });
                assert.ok(outcome.ok, JSON.stringify(outcome));
                const [team] = teamContainers(engine.started);
                assert.deepEqual(team?.dns, [THE_PROXY_ADDRESS]);
            });
        });
    });
});

// ---- A network Docker could not make -------------------------------------------------------------------

describe("Using the workload runner on a Docker that cannot make the run's network", () => {
    describe("given a Docker that refuses a network with no route out", () => {
        describe("when the request is run", () => {
            test("then it should refuse with egress-unenforceable", async () => {
                const { outcome } = await runOn({ ...ENFORCING, internalNetworks: false });
                assert.equal(errorCode(outcome), "egress-unenforceable");
            });
        });
    });

    describe("given a Docker that cannot make it for another reason", () => {
        describe("when the request is run", () => {
            test("then it should end with workload-start-failed, not claim the egress failed", async () => {
                const { engine, logged, outcome } = await runOn({
                    ...ENFORCING,
                    createNetwork: () =>
                        Promise.resolve(failure({ kind: "failed", detail: REASON })),
                });
                assert.equal(errorCode(outcome), "workload-start-failed");
                assert.deepEqual(engine.started, []);
                assert.ok(
                    logged.some((entry) => entry.detail.includes(REASON)),
                    JSON.stringify(logged),
                );
            });
        });
    });
});
