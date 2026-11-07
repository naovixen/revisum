import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { checkImportCycles } from "../../../tools/CheckImportCycles.ts";

const TYPE_ONLY_ADVICE = "; move the shared types to a module both sides can import";

// Writes the files, by repository path, to a fresh folder that has a packages/ folder, and returns
// the cycles the check finds there.
function cyclesIn(files: Readonly<Record<string, string>>): string[] {
    const root = mkdtempSync(join(tmpdir(), "import-cycles-"));
    try {
        mkdirSync(join(root, "packages"));
        for (const [path, source] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), source);
        }
        return checkImportCycles(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe("Using the import cycle check", () => {
    describe("given two files that import each other", () => {
        describe("when the check runs", () => {
            test("then it should report the value cycle as its chain of files", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport const first = () => second();\n',
                    "tools/second.ts":
                        "import { first } from './first.ts';\nexport const second = () => first();\n",
                });
                assert.deepEqual(cycles, [
                    "import cycle: tools/first.ts -> tools/second.ts -> tools/first.ts",
                ]);
            });
        });
    });

    describe("given three files that import each other in a ring", () => {
        describe("when the check runs", () => {
            test("then it should report the chain and every file in the cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport const first = second;\n',
                    "tools/second.ts":
                        'import { third } from "./third.ts";\nexport const second = third;\n',
                    "tools/third.ts":
                        'import { first } from "./first.ts";\nexport const third = first;\n',
                });
                assert.deepEqual(cycles, [
                    "import cycle: tools/first.ts -> tools/second.ts -> tools/third.ts -> tools/first.ts (3 files reach each other: tools/first.ts, tools/second.ts, tools/third.ts)",
                ]);
            });
        });
    });

    describe("given a cycle closed by an import type", () => {
        describe("when the check runs", () => {
            test("then it should report it as a type-only cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport type First = string;\nexport const first = second;\n',
                    "tools/second.ts":
                        'import type { First } from "./first.ts";\nexport const second: First = "";\n',
                });
                assert.deepEqual(cycles, [
                    `import cycle through type-only imports: tools/first.ts -> tools/second.ts -> tools/first.ts${TYPE_ONLY_ADVICE}`,
                ]);
            });
        });
    });

    describe("given a cycle closed by an import whose every name is marked type", () => {
        describe("when the check runs", () => {
            test("then it should report it as a type-only cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport type First = string;\nexport type Other = number;\nexport const first = second;\n',
                    "tools/second.ts":
                        'import { type First, type Other } from "./first.ts";\nexport const second: First | Other = "";\n',
                });
                assert.deepEqual(cycles, [
                    `import cycle through type-only imports: tools/first.ts -> tools/second.ts -> tools/first.ts${TYPE_ONLY_ADVICE}`,
                ]);
            });
        });
    });

    describe("given a cycle closed by an import that marks only some names type", () => {
        describe("when the check runs", () => {
            test("then it should report a value cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport type First = string;\nexport const first = second;\n',
                    "tools/second.ts":
                        'import { type First, first } from "./first.ts";\nexport const second: First = String(first);\n',
                });
                assert.deepEqual(cycles, [
                    "import cycle: tools/first.ts -> tools/second.ts -> tools/first.ts",
                ]);
            });
        });
    });

    describe("given a file that imports itself", () => {
        describe("when the check runs", () => {
            test("then it should report the file as a cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { first as again } from "./first.ts";\nexport const first = 1;\nexport const twice = again * 2;\n',
                });
                assert.deepEqual(cycles, ["import cycle: tools/first.ts -> tools/first.ts"]);
            });
        });
    });

    describe("given a cycle closed only by a dynamic import", () => {
        describe("when the check runs", () => {
            test("then it should pass", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport const first = second;\n',
                    "tools/second.ts":
                        'export const second = async () => (await import("./first.ts")).first;\n',
                });
                assert.deepEqual(cycles, []);
            });
        });
    });

    describe("given a cycle closed by an export from", () => {
        describe("when the check runs", () => {
            test("then it should report the value cycle", () => {
                const cycles = cyclesIn({
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nexport const first = second;\n',
                    "tools/second.ts":
                        'export { first } from "./first.ts";\nexport const second = 2;\n',
                });
                assert.deepEqual(cycles, [
                    "import cycle: tools/first.ts -> tools/second.ts -> tools/first.ts",
                ]);
            });
        });
    });

    describe("given a package file that imports its own package by name", () => {
        describe("when the check runs", () => {
            test("then it should resolve the name to the package's entry file and report the cycle", () => {
                const cycles = cyclesIn({
                    "packages/engine/package.json": JSON.stringify({ name: "@revisum/engine" }),
                    "packages/engine/src/index.ts":
                        'export { run } from "./run.ts";\nexport const version = 1;\n',
                    "packages/engine/src/run.ts":
                        'import { version } from "@revisum/engine";\nexport const run = () => version;\n',
                });
                assert.deepEqual(cycles, [
                    "import cycle: packages/engine/src/index.ts -> packages/engine/src/run.ts -> packages/engine/src/index.ts",
                ]);
            });
        });
    });

    describe("given files whose imports form no cycle", () => {
        describe("when the check runs", () => {
            test("then it should pass", () => {
                const cycles = cyclesIn({
                    "packages/contracts/package.json": JSON.stringify({
                        name: "@revisum/contracts",
                    }),
                    "packages/contracts/src/index.ts":
                        "export type Plan = string;\nexport const empty = '';\n",
                    "tools/first.ts":
                        'import { second } from "./second.ts";\nimport { third } from "./third.ts";\nexport const first = second + third;\n',
                    "tools/second.ts":
                        'import { third } from "./third.ts";\nimport type { Plan } from "@revisum/contracts";\nexport const second: Plan = third;\n',
                    "tools/third.ts":
                        'import { empty } from "@revisum/contracts";\nexport const third = empty;\n',
                });
                assert.deepEqual(cycles, []);
            });
        });
    });
});
