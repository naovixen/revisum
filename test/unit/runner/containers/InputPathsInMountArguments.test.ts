// A run's folders reach Docker inside a --mount argument, which is a comma-separated list of
// key=value options. A path holding a comma, an equals sign, a quote or a control character could
// break that argument or add options of its own, such as a second source naming the host's secrets.
// So an input folder or a repository root holding one is refused before anything starts. The
// container engine is a fake; an ordinary path that is mounted is the counter-example.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunnerErrorCode, type Result } from "@revisum/contracts";
import { dockerRunner, type RunnerLogEntry } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { ENGINE_STARTING_CALLS, fakeContainerEngine } from "../support/FakeContainerEngine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "../examples/DeclaredService.ts";

const POLICY = egressPolicy({ allowOrigins: [] });
const ORDINARY_INPUT = "test/fixtures";
const UNSAFE_PATHS: readonly { readonly why: string; readonly path: string }[] = [
    { why: "a comma that adds a mount option", path: "x,source=/home/u/.ssh" },
    { why: "an equals sign", path: "x=y" },
    { why: "a double quote", path: 'x"y' },
    { why: "a newline", path: "x\ny" },
];

type RunnerSetup = { readonly root: string; readonly inputs: readonly string[] };

async function startOn({ root, inputs }: RunnerSetup) {
    const engine = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
    });
    const logged: RunnerLogEntry[] = [];
    const runner = dockerRunner({
        engine,
        repositoryRoot: root,
        inputs,
        dependenciesVolume: null,
        log: (entry) => {
            logged.push(entry);
        },
    });
    let useCalls = 0;
    const outcome: Result<unknown, { readonly code: string }> = await runner.withRun(
        imageDigest(PINNED_IMAGE_ID),
        POLICY,
        () => {
            useCalls += 1;
            return Promise.resolve();
        },
    );
    return { engine, logged, outcome, useCalls: () => useCalls };
}

type Started = Awaited<ReturnType<typeof startOn>>;

function assertRefusedBeforeAnythingStarted(started: Started): void {
    const { engine, logged, outcome, useCalls } = started;
    assert.ok(!outcome.ok, "the run started");
    assert.equal(outcome.error.code, RunnerErrorCode.StartFailed);
    assert.equal(useCalls(), 0);
    assert.deepEqual(
        engine.calls.filter((call) => ENGINE_STARTING_CALLS.includes(call)),
        [],
    );
    assert.ok(
        logged.some((entry) => entry.code === "start-failed"),
        JSON.stringify(logged),
    );
}

describe("Using the isolated runner", () => {
    for (const { why, path } of UNSAFE_PATHS) {
        describe(`given an input folder holding ${why}`, () => {
            describe("when a run is started", () => {
                test("then it should refuse the run before anything starts", async () => {
                    assertRefusedBeforeAnythingStarted(
                        await startOn({ root: REPOSITORY_ROOT, inputs: [path] }),
                    );
                });
            });
        });

        describe(`given a repository root holding ${why}`, () => {
            describe("when a run is started", () => {
                test("then it should refuse the run before anything starts", async () => {
                    assertRefusedBeforeAnythingStarted(
                        await startOn({ root: `/srv/${path}/repository`, inputs: [] }),
                    );
                });
            });
        });
    }

    describe("given an ordinary input folder under an ordinary root", () => {
        describe("when a run is started", () => {
            test("then it should mount the folder and reach `use`", async () => {
                const { engine, outcome, useCalls } = await startOn({
                    root: REPOSITORY_ROOT,
                    inputs: [ORDINARY_INPUT],
                });
                assert.ok(outcome.ok, JSON.stringify(outcome));
                assert.equal(useCalls(), 1);
                assert.ok(
                    engine.started.some((options) =>
                        options.mounts.some(
                            (mount) => mount.target === `/workspace/${ORDINARY_INPUT}`,
                        ),
                    ),
                    JSON.stringify(engine.started.map((options) => options.mounts)),
                );
            });
        });
    });
});
