// A removal from the output folder never rejects: an engine that breaks while it looks up the image,
// or a log that throws, is reported and leaves nothing started.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OutputRemoval } from "@revisum/contracts";
import { workloadRunner } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import { BREAKAGES, REASON_IT_BROKE, engineBreaking } from "./EngineBreaking.ts";
import { fakeContainerEngine, type FakeEngineSettings } from "./fake-container-engine.ts";
import { PINNED_IMAGE_ID } from "./runner-examples.ts";
import { PRESENT_IMAGES, TEAM_IMAGE_ID, outputFolder, runnerOn } from "./workload-examples.ts";

const ENFORCING: FakeEngineSettings = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
};
const LOG_BROKE = "the log broke";

// ---- Removal from the output folder ------------------------------------------------------------------

describe("Using the removal from a workload's output folder", () => {
    const removal = (): OutputRemoval => ({
        image: TEAM_IMAGE_ID,
        outputDirectory: outputFolder(),
        paths: ["left-over.txt"],
        hostFailure: "EPERM from the host's own attempt",
    });

    for (const breakage of BREAKAGES) {
        for (const [name, call] of [
            ["asking for the image", { method: "imageId" }],
            ["asking for the image's user", { method: "imageUser" }],
        ] as const) {
            describe(`given an engine that ${breakage} when ${name}`, () => {
                describe("when what a run left is removed", () => {
                    test("then it should resolve, report why and start nothing", async () => {
                        const engine = engineBreaking(ENFORCING, call, breakage);
                        const { runner, logged } = runnerOn(engine);
                        await runner.removeFromOutput(removal());
                        assert.ok(
                            logged.some((entry) => entry.detail.includes(REASON_IT_BROKE)),
                            JSON.stringify(logged),
                        );
                        assert.deepEqual(engine.started, []);
                    });
                });
            });
        }
    }

    describe("given a log that throws", () => {
        describe("when a removal cannot use a container", () => {
            test("then it should still resolve", async () => {
                const engine = fakeContainerEngine({
                    ...ENFORCING,
                    imageId: () => Promise.resolve({ kind: "absent" }),
                });
                const runner = workloadRunner({
                    engine,
                    repositoryRoot: REPOSITORY_ROOT,
                    checkout: REPOSITORY_ROOT,
                    log: () => {
                        throw new Error(LOG_BROKE);
                    },
                });
                await runner.removeFromOutput(removal());
                assert.deepEqual(engine.started, []);
            });
        });
    });
});
