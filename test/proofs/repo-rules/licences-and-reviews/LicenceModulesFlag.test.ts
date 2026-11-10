// A check told to read another installed-packages folder and given none must say so. Falling back to
// node_modules would pass, or fail, on a folder nobody asked it to read.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { describeRun, runTool } from "../../../support/repository/ToolRun.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const TOOL = "repo-rules/docs/CheckLicences.ts";
const FLAG = "--modules";

describe("Using the licence check", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given the modules flag", () => {
        describe("when it has no value", () => {
            test("then it should fail, naming the flag", { timeout: TIMEOUT }, () => {
                const run = runTool(TOOL, [FLAG], { cwd: scratch.root() });
                assert.equal(run.passed, false, describeRun(run));
                assert.ok(run.output.includes(FLAG), describeRun(run));
                assert.ok(!run.output.includes("licence check passed"), describeRun(run));
            });
        });

        describe("when it names a folder", () => {
            test("then it should read that folder and pass", { timeout: TIMEOUT }, () => {
                const run = runTool(TOOL, [FLAG, "node_modules"], { cwd: scratch.root() });
                assert.equal(run.passed, true, describeRun(run));
            });
        });
    });

    describe("given no modules flag", () => {
        describe("when the check runs", () => {
            test("then it should read node_modules and pass", { timeout: TIMEOUT }, () => {
                const run = runTool(TOOL, [], { cwd: scratch.root() });
                assert.equal(run.passed, true, describeRun(run));
            });
        });
    });
});

describe("Using the repository rules tool", () => {
    describe("given the modules flag", () => {
        describe("when it has no value", () => {
            test(
                "then it should run nothing and fail, naming the flag",
                { timeout: TIMEOUT },
                () => {
                    const run = runTool("repo-rules/RunRepositoryRules.ts", [FLAG], {
                        cwd: REPOSITORY_ROOT,
                    });
                    assert.equal(run.status, 2, describeRun(run));
                    assert.ok(run.output.includes(FLAG), describeRun(run));
                    assert.ok(!run.output.includes("licence check"), describeRun(run));
                },
            );
        });
    });
});
