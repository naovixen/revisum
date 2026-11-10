// The repository's .git folder never reaches a run, however its name is written. Windows ignores
// case, so ".GIT" names the same folder as ".git", and a check that compared exact text would let
// it through. Names that merely start with ".git", which are ordinary folders, are the
// counter-examples.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dockerRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { fakeContainerEngine } from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";
import {
    PRESENT_IMAGES,
    errorCode,
    outputFolder,
    runnerOn,
    teamContainers,
    workloadRequest,
} from "../examples/WorkloadRequest.ts";

const POLICY = egressPolicy({ allowOrigins: [] });

function runnerWithInputs(inputs: readonly string[]) {
    const engine = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
    });
    const logged: RunnerLogEntry[] = [];
    const runner = dockerRunner({
        engine,
        repositoryRoot: REPOSITORY_ROOT,
        inputs,
        log: (entry) => {
            logged.push(entry);
        },
    });
    return { engine, runner, logged };
}

const GIT_FOLDER_INPUTS = [
    ".git",
    ".GIT",
    ".Git",
    ".gIt",
    "fixtures/.GIT",
    ".GIT/config",
    "fixtures/.Git/hooks",
    "fixtures\\.GIT\\hooks",
];

for (const input of GIT_FOLDER_INPUTS) {
    test(`the input ${input} names a .git folder, so start fails and nothing is started`, async () => {
        const { engine, runner, logged } = runnerWithInputs([input]);
        const started = await runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, () =>
            Promise.resolve(),
        );
        assert.ok(
            !started.ok,
            `the input ${input} was accepted, with mounts ${JSON.stringify(engine.started.flatMap((options) => options.mounts))}`,
        );
        assert.deepEqual(started.error, { code: "start-failed" });
        assert.ok(
            logged.some((entry) => entry.code === "start-failed"),
            JSON.stringify(logged),
        );
        assert.deepEqual(engine.started, []);
        assert.deepEqual(engine.existingNetworks(), []);
    });
}

for (const input of [".github", ".gitignored", "fixtures/.github", "fixtures/git"]) {
    test(`counter-example: the input ${input} is only named like .git, so it is mounted`, async () => {
        const { engine, runner } = runnerWithInputs([input]);
        const started = await runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, () => {
            const targets = engine.started
                .flatMap((options) => options.mounts)
                .map((mount) => mount.target);
            assert.ok(
                targets.some((target) => target.endsWith(`/${input}`)),
                JSON.stringify(targets),
            );
            return Promise.resolve();
        });
        assert.ok(started.ok, JSON.stringify(started));
    });
}

// ---- The workload runner's checkout -------------------------------------------------------------------

const ENFORCING_HOST = {
    localImageId: PINNED_IMAGE_ID,
    internalNetworks: true,
    probe: "blocked",
    images: PRESENT_IMAGES,
} as const;

// The folders of a checkout made for the test, as mounted on the team's container.
async function mountedCheckoutFolders(folders: readonly string[]): Promise<readonly string[]> {
    const checkout = mkdtempSync(join(tmpdir(), "git-mount-check-"));
    try {
        for (const folder of folders) {
            mkdirSync(join(checkout, folder));
        }
        const engine = fakeContainerEngine(ENFORCING_HOST);
        const { runner } = runnerOn(engine, checkout);
        await runner.run(
            workloadRequest({ workingDirectory: ".", outputDirectory: outputFolder() }),
        );
        const [team] = teamContainers(engine.started);
        assert.ok(team !== undefined, "the team's container was started");
        return team.mounts
            .filter((mount) => mount.source.startsWith(checkout))
            .map((mount) => mount.source.slice(checkout.length + 1));
    } finally {
        rmSync(checkout, { recursive: true, force: true });
    }
}

test("a checkout's .GIT folder is left out of the workload's mounts, as .git is", async () => {
    assert.deepEqual(await mountedCheckoutFolders([".GIT", "src"]), ["src"]);
});

test("counter-example: a checkout's .github folder is mounted", async () => {
    assert.deepEqual([...(await mountedCheckoutFolders([".github", "src"]))].sort(), [
        ".github",
        "src",
    ]);
});

test("a working directory inside a .GIT folder is refused", async () => {
    const engine = fakeContainerEngine(ENFORCING_HOST);
    const { runner } = runnerOn(engine);
    const outcome = await runner.run(workloadRequest({ workingDirectory: ".GIT/hooks" }));
    assert.equal(errorCode(outcome), "workload-start-failed");
    assert.deepEqual(engine.started, []);
});
