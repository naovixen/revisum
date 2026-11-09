// Explore mode's browser and its isolated runner are always there as ports, and each says for itself
// when it is not available, so the command never branches on a port being absent. The project a crawl
// runs on is the one whose trust was checked: the file is read once, however it changes afterwards.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success, type VersionControlPort } from "@revisum/engine";
import { fakeVersionControlPort } from "#test-support/fakes/ports/FakeVersionControlPort.ts";
import type { Recorded } from "#test-support/fakes/RecordCalls.ts";
import { type JsonRecord } from "../../unit/cli/commands/examples/DraftCommand.ts";
import {
    DRAFT_OUT,
    PAGE_MAP_OUT,
    containerPageMap,
    exploreArguments,
    exploreErrorCodes,
    watchedFakeRunner,
    withExploreRun,
    type ExploreRun,
} from "./examples/ExploreCommandPorts.ts";

function assertStoppedBeforeTheBrowserAndPlanner(run: ExploreRun, code: string): void {
    assert.deepEqual(exploreErrorCodes(run), [code], run.outcome.stdout);
    assert.notEqual(run.outcome.exitCode, 0);
    assert.equal(run.planner.received.length, 0, "the planner was called");
    assert.equal(run.workspace.exists(DRAFT_OUT), false, "a draft was written");
    assert.equal(run.workspace.exists(PAGE_MAP_OUT), false, "a page map was written");
}

const home = (site: ExploreRun["site"]): string => `${site.origin}/`;

// A protected branch whose project.json is `first` when read once, and a different project after.
function protectedFileThatChanges(first: JsonRecord): Recorded<VersionControlPort> {
    const changed = { ...first, productionOrigins: [] };
    const versions = [first, changed];
    return fakeVersionControlPort({
        protectedFile(path) {
            if (path !== "project.json") {
                return Promise.resolve(failure("not-found"));
            }
            const version = versions.shift() ?? changed;
            return Promise.resolve(
                success({
                    bytes: new TextEncoder().encode(JSON.stringify(version)),
                    commit: "commit-protected",
                }),
            );
        },
    });
}

describe("Using the draft command's explore mode", () => {
    describe("given --host and no browser", () => {
        describe("when the command runs", () => {
            test("then it should stop with target-unavailable", async () => {
                await withExploreRun(
                    {
                        argv: (site) => exploreArguments(home(site), ["--host", "--json"]),
                        browser: false,
                    },
                    (run) => {
                        assertStoppedBeforeTheBrowserAndPlanner(run, "target-unavailable");
                    },
                );
            });
        });
    });

    describe("given no --host and no isolated runner", () => {
        describe("when the command runs", () => {
            test("then it should stop with explore-runner-unavailable", async () => {
                await withExploreRun(
                    { argv: (site) => exploreArguments(home(site), ["--json"]) },
                    (run) => {
                        assertStoppedBeforeTheBrowserAndPlanner(run, "explore-runner-unavailable");
                    },
                );
            });
        });
    });

    describe("given a protected project file that changes after it is first read", () => {
        describe("when a crawl runs in the isolated runner", () => {
            test("then it should crawl the project that was trust-checked, read once", async () => {
                let versionControl: Recorded<VersionControlPort> | undefined;
                await withExploreRun(
                    {
                        argv: (site) => exploreArguments(home(site), ["--json"]),
                        runner: (site) =>
                            watchedFakeRunner({
                                level: "isolated",
                                output: containerPageMap(site.origin).printed,
                            }),
                        versionControl: (project) => {
                            versionControl = protectedFileThatChanges(project);
                            return versionControl;
                        },
                    },
                    (run) => {
                        const [crawl] = run.runner?.execs ?? [];
                        assert.ok(crawl !== undefined, run.outcome.stdout);
                        const given: unknown = JSON.parse(crawl.command[2] ?? "");
                        assert.ok(typeof given === "object" && given !== null);
                        assert.deepEqual(Reflect.get(given, "project"), run.project);
                        assert.equal(versionControl?.calls.count("protectedFile"), 1);
                    },
                );
            });
        });
    });
});
