// The test runner tells browser tests from the rest by what imports test/support/browsers.ts. If
// that file moved without the runner knowing, every browser test would quietly run in parallel, so
// the runner refuses to run at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { describeRun, runTool } from "../support/tool-runs.ts";

const BROWSER_MODULE = "test/support/browsers.ts";
const PASSING_TEST = "import { test } from 'node:test';\ntest('passes', () => {});\n";

describe("Using the test runner", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "test-runner-"));
        mkdirSync(join(root, "test", "proofs"), { recursive: true });
        mkdirSync(join(root, "test", "support"), { recursive: true });
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    describe("given a folder of tests", () => {
        beforeEach(() => {
            writeFileSync(join(root, "test", "proofs", "passing.test.ts"), PASSING_TEST);
        });

        describe("and the browser module is missing", () => {
            describe("when the folder runs", () => {
                test("then it should fail, naming the module, and run nothing", () => {
                    const run = runTool("run-test-folder.ts", ["test/proofs"], { cwd: root });
                    assert.equal(run.status, 1, describeRun(run));
                    assert.match(run.output, /test[\\/]support[\\/]browsers\.ts does not exist/);
                    assert.doesNotMatch(run.output, /passes/);
                });
            });
        });

        describe("and the browser module exists", () => {
            beforeEach(() => {
                writeFileSync(join(root, BROWSER_MODULE), "export {};\n");
            });

            describe("when the folder runs", () => {
                test("then it should run the tests", () => {
                    const run = runTool("run-test-folder.ts", ["test/proofs"], { cwd: root });
                    assert.equal(run.status, 0, describeRun(run));
                    assert.match(run.output, /passes/);
                });
            });
        });
    });

    describe("given a folder with no tests yet", () => {
        describe("and the browser module is missing", () => {
            describe("when the folder runs", () => {
                test("then it should report the empty folder and pass", () => {
                    const run = runTool("run-test-folder.ts", ["test/proofs"], { cwd: root });
                    assert.equal(run.status, 0, describeRun(run));
                    assert.match(run.output, /no tests in test[\\/]proofs yet/);
                });
            });
        });
    });
});
