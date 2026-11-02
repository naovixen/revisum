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

    describe("given one test that reaches the browser module and one that doesn't", () => {
        const browserTestImporting = (importPath: string): string =>
            `import {} from '${importPath}';\nimport { test } from 'node:test';\ntest('uses a browser', () => {});\n`;
        const plainTest =
            "import { test } from 'node:test';\ntest('needs no browser', () => {});\n";

        beforeEach(() => {
            writeFileSync(join(root, BROWSER_MODULE), "export {};\n");
            writeFileSync(
                join(root, "package.json"),
                JSON.stringify({
                    type: "module",
                    imports: { "#test-support/*": "./test/support/*" },
                }),
            );
            // Sorted first, so only being told apart as a browser test can make it run second.
            writeFileSync(join(root, "test", "proofs", "z-plain.test.ts"), plainTest);
        });

        for (const importPath of ["#test-support/browsers.ts", "../support/browsers.ts"]) {
            describe(`and the browser test imports it as ${importPath}`, () => {
                beforeEach(() => {
                    writeFileSync(
                        join(root, "test", "proofs", "a-browser.test.ts"),
                        browserTestImporting(importPath),
                    );
                });

                describe("when the folder runs", () => {
                    test("then it should run the browser test after the other", () => {
                        const run = runTool("run-test-folder.ts", ["test/proofs"], { cwd: root });
                        assert.equal(run.status, 0, describeRun(run));
                        assert.ok(
                            run.output.indexOf("needs no browser") <
                                run.output.indexOf("uses a browser"),
                            describeRun(run),
                        );
                    });
                });
            });
        }
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
