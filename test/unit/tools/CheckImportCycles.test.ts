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

type Edge = readonly [from: string, to: string];
type ImportEdges = { readonly value: readonly Edge[]; readonly typeOnly: readonly Edge[] };

// One file under tools/ for each name the edges use, each importing as they say.
function filesFor(edges: ImportEdges): Record<string, string> {
    const imports = new Map<string, string[]>();
    const add = (from: string, line: string): void => {
        imports.set(from, [...(imports.get(from) ?? []), line]);
    };
    for (const [from, to] of edges.value) {
        add(from, `import { value as ${to}Value } from "./${to}.ts";`);
    }
    for (const [from, to] of edges.typeOnly) {
        add(from, `import type { Shape as ${to}Shape } from "./${to}.ts";`);
        add(to, "");
    }
    return Object.fromEntries(
        [...imports].map(([name, lines]) => [
            `tools/${name}.ts`,
            [...lines, "export const value = 1;", "export type Shape = number;", ""].join("\n"),
        ]),
    );
}

const CYCLE_REPORT =
    /^import cycle(?<typeOnly> through type-only imports)?: (?<chain>.+?)(?: \(\d+ files reach each other: [^)]*\))?(?:; move the shared types to a module both sides can import)?$/;

type CycleReport = { readonly isTypeOnly: boolean; readonly chain: readonly string[] };

function readReport(problem: string): CycleReport {
    const groups = CYCLE_REPORT.exec(problem)?.groups;
    if (groups?.["chain"] === undefined) {
        throw new Error(`not a cycle report: ${problem}`);
    }
    return {
        isTypeOnly: groups["typeOnly"] !== undefined,
        chain: groups["chain"].split(" -> ").map((path) => path.replace(/^tools\/(.+)\.ts$/, "$1")),
    };
}

const hasEdge = (edges: readonly Edge[], from: string, to: string): boolean =>
    edges.some((edge) => edge[0] === from && edge[1] === to);

// Each step of the chain, as from and to.
const stepsOf = (chain: readonly string[]): Edge[] =>
    chain.slice(1).map((to, index) => [chain[index] ?? "", to] as const);

const isClosedChainOf = (chain: readonly string[], edges: ImportEdges): boolean =>
    chain.length > 1 &&
    chain[0] === chain.at(-1) &&
    stepsOf(chain).every(
        ([from, to]) => hasEdge(edges.value, from, to) || hasEdge(edges.typeOnly, from, to),
    );

const typeOnlyStepsOf = (chain: readonly string[], edges: ImportEdges): Edge[] =>
    stepsOf(chain).filter(
        ([from, to]) => !hasEdge(edges.value, from, to) && hasEdge(edges.typeOnly, from, to),
    );

// The two-file cycle through these names, starting from whichever file the report starts from.
function chainFrom(problem: string | undefined, names: readonly [string, string]): string[] {
    const [one, other] = names;
    return problem?.includes(`: tools/${other}.ts -> `) === true
        ? [other, one, other]
        : [one, other, one];
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
                assert.deepEqual(cycles.map(readReport), [
                    { isTypeOnly: true, chain: chainFrom(cycles[0], ["first", "second"]) },
                ]);
                assert.equal(cycles[0]?.endsWith(TYPE_ONLY_ADVICE), true, cycles[0]);
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
                assert.deepEqual(cycles.map(readReport), [
                    { isTypeOnly: true, chain: chainFrom(cycles[0], ["first", "second"]) },
                ]);
                assert.equal(cycles[0]?.endsWith(TYPE_ONLY_ADVICE), true, cycles[0]);
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

    describe("given a value cycle that type-only imports join to a second file", () => {
        const edges: ImportEdges = {
            value: [
                ["first", "second"],
                ["second", "first"],
            ],
            typeOnly: [
                ["second", "third"],
                ["third", "first"],
            ],
        };

        describe("when the check runs", () => {
            test("then it should report the value cycle, and a type-only cycle through a type-only import", () => {
                const reports = cyclesIn(filesFor(edges)).map(readReport);
                const valueReports = reports.filter((report) => !report.isTypeOnly);
                const typeOnlyReports = reports.filter((report) => report.isTypeOnly);
                assert.equal(valueReports.length, 1, JSON.stringify(reports));
                assert.deepEqual(new Set(valueReports[0]?.chain), new Set(["first", "second"]));
                assert.equal(typeOnlyReports.length, 1, JSON.stringify(reports));
                const chain = typeOnlyReports[0]?.chain ?? [];
                assert.ok(
                    isClosedChainOf(chain, edges),
                    `not a cycle of the graph: ${chain.join(" -> ")}`,
                );
                assert.notDeepEqual(
                    typeOnlyStepsOf(chain, edges),
                    [],
                    `no type-only import in: ${chain.join(" -> ")}`,
                );
            });
        });
    });

    describe("given two value cycles joined both ways by type-only imports", () => {
        const edges: ImportEdges = {
            value: [
                ["first", "second"],
                ["second", "first"],
                ["third", "fourth"],
                ["fourth", "third"],
            ],
            typeOnly: [
                ["second", "third"],
                ["fourth", "first"],
            ],
        };

        describe("when the check runs", () => {
            test("then it should report both value cycles, and the type-only cycle through all four files", () => {
                const reports = cyclesIn(filesFor(edges)).map(readReport);
                const valueCycles = reports
                    .filter((report) => !report.isTypeOnly)
                    .map((report) => [...new Set(report.chain)].toSorted());
                const typeOnlyReports = reports.filter((report) => report.isTypeOnly);
                assert.deepEqual(
                    valueCycles.toSorted(),
                    [
                        ["first", "second"],
                        ["fourth", "third"],
                    ],
                    JSON.stringify(reports),
                );
                assert.equal(typeOnlyReports.length, 1, JSON.stringify(reports));
                const chain = typeOnlyReports[0]?.chain ?? [];
                assert.ok(
                    isClosedChainOf(chain, edges),
                    `not a cycle of the graph: ${chain.join(" -> ")}`,
                );
                assert.notDeepEqual(
                    typeOnlyStepsOf(chain, edges),
                    [],
                    `no type-only import in: ${chain.join(" -> ")}`,
                );
                assert.deepEqual(new Set(chain), new Set(["first", "second", "third", "fourth"]));
            });
        });
    });
});
