// The test runner tells browser tests from the rest by what imports test/support/browser/Browsers.ts. If
// that file moved without the runner knowing, every browser test would quietly run in parallel, so
// the runner refuses to run at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { describeRun, runTool } from "../../../support/repository/ToolRun.ts";

const BROWSER_MODULE = "test/support/browser/Browsers.ts";
const PASSING_TEST = "import { test } from 'node:test';\ntest('passes', () => {});\n";

describe("Using the test runner", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "test-runner-"));
        mkdirSync(join(root, "test", "proofs"), { recursive: true });
        mkdirSync(join(root, "test", "support", "browser"), { recursive: true });
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
                    const run = runTool("test-runner/RunTestFolder.ts", ["test/proofs"], {
                        cwd: root,
                    });
                    assert.equal(run.status, 1, describeRun(run));
                    assert.match(
                        run.output,
                        /test[\\/]support[\\/]browser[\\/]Browsers\.ts does not exist/,
                    );
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
                    const run = runTool("test-runner/RunTestFolder.ts", ["test/proofs"], {
                        cwd: root,
                    });
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

        for (const importPath of [
            "#test-support/browser/Browsers.ts",
            "../support/browser/Browsers.ts",
        ]) {
            describe(`and the browser test imports it as ${importPath}`, () => {
                beforeEach(() => {
                    writeFileSync(
                        join(root, "test", "proofs", "a-browser.test.ts"),
                        browserTestImporting(importPath),
                    );
                });

                describe("when the folder runs", () => {
                    test("then it should run the browser test after the other", () => {
                        const run = runTool("test-runner/RunTestFolder.ts", ["test/proofs"], {
                            cwd: root,
                        });
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

    describe("given five browser tests and one plain test", () => {
        const browserNames = ["a", "b", "c", "d", "e"];
        const testNamed = (title: string, importPath: string | null): string =>
            `${importPath === null ? "" : `import {} from '${importPath}';\n`}import { test } from 'node:test';\ntest('${title}', () => {});\n`;
        const browsersRunIn = (output: string): string[] =>
            [...output.matchAll(/ran ([a-e])-browser/g)].map((match) => match[1] ?? "");

        beforeEach(() => {
            writeFileSync(join(root, BROWSER_MODULE), "export {};\n");
            for (const name of browserNames) {
                writeFileSync(
                    join(root, "test", "proofs", `${name}-browser.test.ts`),
                    testNamed(`ran ${name}-browser`, "../support/browser/Browsers.ts"),
                );
            }
            writeFileSync(
                join(root, "test", "proofs", "plain.test.ts"),
                testNamed("ran plain", null),
            );
        });

        describe("when the run is split into three browser shards", () => {
            test("then it should run every browser file in exactly one shard, and the same split each time", () => {
                const shards = [1, 2, 3].map((position) => {
                    const run = runTool(
                        "test-runner/RunTestFolder.ts",
                        ["--browser-shard", `${position}/3`, "test/proofs"],
                        { cwd: root },
                    );
                    assert.equal(run.status, 0, describeRun(run));
                    assert.doesNotMatch(run.output, /ran plain/);
                    return browsersRunIn(run.output).sort();
                });
                assert.deepEqual(shards.flat().sort(), browserNames);
                for (const shard of shards) {
                    assert.ok(shard.length >= 1 && shard.length <= 2, shards.join(" | "));
                }
                const again = runTool(
                    "test-runner/RunTestFolder.ts",
                    ["--browser-shard", "2/3", "test/proofs"],
                    { cwd: root },
                );
                assert.deepEqual(browsersRunIn(again.output).sort(), shards[1]);
            });
        });

        for (const badShard of ["0/3", "4/3", "abc", "1/0", "1"]) {
            describe(`when the shard is given as ${badShard}`, () => {
                test("then it should refuse with the usage message and run nothing", () => {
                    const run = runTool(
                        "test-runner/RunTestFolder.ts",
                        ["--browser-shard", badShard, "test/proofs"],
                        { cwd: root },
                    );
                    assert.equal(run.status, 2, describeRun(run));
                    assert.match(run.output, /usage:/);
                    assert.doesNotMatch(run.output, /ran /);
                });
            });
        }

        describe("when the run leaves out browser files", () => {
            test("then it should run only the file that drives no browser", () => {
                const run = runTool(
                    "test-runner/RunTestFolder.ts",
                    ["--without-browser", "test/proofs"],
                    { cwd: root },
                );
                assert.equal(run.status, 0, describeRun(run));
                assert.match(run.output, /ran plain/);
                assert.deepEqual(browsersRunIn(run.output), []);
            });
        });

        describe("when a flag is not one the tool knows", () => {
            test("then it should exit 2 instead of passing on an empty folder", () => {
                const run = runTool(
                    "test-runner/RunTestFolder.ts",
                    ["--browser-shards", "test/proofs"],
                    { cwd: root },
                );
                assert.equal(run.status, 2, describeRun(run));
                assert.match(run.output, /usage:/);
                assert.doesNotMatch(run.output, /ran /);
            });
        });
    });

    describe("given two browser files that each take a moment to run", () => {
        const slowBrowserTest = (name: string): string =>
            [
                "import {} from '../support/browser/Browsers.ts';",
                "import { appendFileSync } from 'node:fs';",
                "import { test } from 'node:test';",
                `test('slow ${name}', async () => {`,
                `  appendFileSync('order.log', 'start-${name}\\n');`,
                "  await new Promise((done) => setTimeout(done, 500));",
                `  appendFileSync('order.log', 'end-${name}\\n');`,
                "});",
            ].join("\n");

        beforeEach(() => {
            writeFileSync(join(root, BROWSER_MODULE), "export {};\n");
            writeFileSync(join(root, "test", "proofs", "a-slow.test.ts"), slowBrowserTest("a"));
            writeFileSync(join(root, "test", "proofs", "b-slow.test.ts"), slowBrowserTest("b"));
        });

        describe("when both land in one browser shard", () => {
            test("then it should finish one before it starts the other", () => {
                const run = runTool(
                    "test-runner/RunTestFolder.ts",
                    ["--browser-shard", "1/1", "test/proofs"],
                    { cwd: root },
                );
                assert.equal(run.status, 0, describeRun(run));
                const order = readFileSync(join(root, "order.log"), "utf8").trim().split("\n");
                assert.equal(order.length, 4, order.join(","));
                assert.equal(order[0]?.replace("start-", ""), order[1]?.replace("end-", ""));
                assert.equal(order[2]?.replace("start-", ""), order[3]?.replace("end-", ""));
            });
        });
    });

    describe("given test files and recorded results", () => {
        const resultLine = (file: string): string =>
            `${JSON.stringify({ kind: "test", file, name: "passes", line: 1, passed: true, skipped: false, durationMilliseconds: 1 })}\n`;

        beforeEach(() => {
            writeFileSync(join(root, "test", "proofs", "first.test.ts"), PASSING_TEST);
            writeFileSync(join(root, "test", "proofs", "second.test.ts"), PASSING_TEST);
            mkdirSync(join(root, ".test-results"), { recursive: true });
        });

        describe("and every file has a result", () => {
            beforeEach(() => {
                writeFileSync(
                    join(root, ".test-results", "tests-proofs.jsonl"),
                    resultLine("test/proofs/first.test.ts") +
                        resultLine("test/proofs/second.test.ts"),
                );
            });

            describe("when the results are required", () => {
                test("then it should pass without running any test", () => {
                    const run = runTool(
                        "test-runner/RunTestFolder.ts",
                        ["--require-results", "test/proofs"],
                        { cwd: root },
                    );
                    assert.equal(run.status, 0, describeRun(run));
                    assert.doesNotMatch(run.output, /passes/);
                });
            });
        });

        describe("and one file has no result", () => {
            beforeEach(() => {
                writeFileSync(
                    join(root, ".test-results", "tests-proofs.jsonl"),
                    resultLine("test/proofs/first.test.ts"),
                );
            });

            describe("when the results are required", () => {
                test("then it should fail, naming the file without a result", () => {
                    const run = runTool(
                        "test-runner/RunTestFolder.ts",
                        ["--require-results", "test/proofs"],
                        { cwd: root },
                    );
                    assert.equal(run.status, 1, describeRun(run));
                    assert.match(run.output, /second\.test\.ts has no result/);
                    assert.doesNotMatch(run.output, /first\.test\.ts has no result/);
                });
            });
        });
    });

    describe("given a folder with no tests yet", () => {
        describe("and the browser module is missing", () => {
            describe("when the folder runs", () => {
                test("then it should report the empty folder and pass", () => {
                    const run = runTool("test-runner/RunTestFolder.ts", ["test/proofs"], {
                        cwd: root,
                    });
                    assert.equal(run.status, 0, describeRun(run));
                    assert.match(run.output, /no tests in test[\\/]proofs yet/);
                });
            });
        });
    });
});
