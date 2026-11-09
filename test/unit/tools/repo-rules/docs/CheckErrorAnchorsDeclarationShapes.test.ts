// The check reads each declaration's codes out of source text, so each shape a declaration can take
// is read for what it holds: a shorthand member names a set, a quoted key is no code, a last field
// with no semicolon is not a borrowed set, and a type written before its constant object still
// leaves the object's codes to read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
    ERROR_CODE_UNIONS,
    ERRORS_PAGE,
    checkErrorAnchors,
    readDeclaredCodes,
} from "../../../../../tools/repo-rules/docs/CheckErrorAnchors.ts";
import { codeTokens } from "../../../../../tools/repo-rules/ListSourceFiles.ts";

const declaredIn = (source: string, name = "Codes") => readDeclaredCodes(codeTokens(source), name);

const codeOf = (unionName: string): string => `${unionName}-code`;

const headingsOfEveryUnion = (): readonly string[] =>
    ERROR_CODE_UNIONS.map((union) => `## ${codeOf(union.name)}`);

const pageWith = (headings: readonly string[]): string => `# Errors\n\n${headings.join("\n\n")}\n`;

// A tree holding one heading for every code, and RunnerErrorCode declared as `declaration`.
function plantTree(root: string, declaration: string): void {
    const sourceByFile = new Map<string, string>();
    for (const union of ERROR_CODE_UNIONS) {
        const source =
            union.name === "RunnerErrorCode"
                ? declaration
                : `export const ${union.name} = { Only: "${codeOf(union.name)}" } as const;`;
        sourceByFile.set(union.file, `${sourceByFile.get(union.file) ?? ""}${source}\n`);
    }
    for (const [file, source] of sourceByFile) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), source);
    }
    mkdirSync(dirname(join(root, ERRORS_PAGE)), { recursive: true });
    writeFileSync(join(root, ERRORS_PAGE), pageWith(headingsOfEveryUnion()));
}

describe("Using the declared codes reader", () => {
    describe("given a type with fields", () => {
        describe("when the last field has no semicolon and its type is a name", () => {
            test("then it should not count that name as a borrowed set", () => {
                assert.deepEqual(declaredIn("type Codes = { code: 'first'; origin: Origin };"), {
                    codes: ["first"],
                    borrowedSets: [],
                });
            });
        });
    });

    describe("given a constant object with a shorthand member", () => {
        describe("when the member comes last", () => {
            test("then it should record the member as a borrowed set", () => {
                assert.deepEqual(declaredIn("const Codes = { Own: 'own', Moved } as const;"), {
                    codes: ["own"],
                    borrowedSets: ["Moved"],
                });
            });
        });

        describe("when the member comes first", () => {
            test("then it should record the member as a borrowed set", () => {
                assert.deepEqual(declaredIn("const Codes = { Moved, Own: 'own' } as const;"), {
                    codes: ["own"],
                    borrowedSets: ["Moved"],
                });
            });
        });
    });

    describe("given a constant object with a quoted key", () => {
        describe("when its value is a code", () => {
            test("then it should read the value and not the key", () => {
                assert.deepEqual(
                    declaredIn("const Codes = { 'quoted-key': 'first', Second: 'second' } as const;"),
                    { codes: ["first", "second"], borrowedSets: [] },
                );
            });
        });

        describe("when its value is a borrowed set", () => {
            test("then it should record the set and read no code from the key", () => {
                assert.deepEqual(declaredIn("const Codes = { 'quoted-key': SharedCodes } as const;"), {
                    codes: [],
                    borrowedSets: ["SharedCodes"],
                });
            });
        });
    });

    describe("given a type declared before the constant object of the same name", () => {
        describe("when the type is the values of the object", () => {
            test("then it should read the object's codes", () => {
                assert.deepEqual(
                    declaredIn(
                        "export type Codes = (typeof Codes)[keyof typeof Codes];\nexport const Codes = { First: 'first', Second: 'second' } as const;",
                    ),
                    { codes: ["first", "second"], borrowedSets: [] },
                );
            });
        });
    });
});

const RUNNER_CODE = codeOf("RunnerErrorCode");

const DECLARATIONS_THE_CHECK_ACCEPTS: readonly (readonly [string, string])[] = [
    ["a quoted key", `export const RunnerErrorCode = { "quoted-key": "${RUNNER_CODE}" } as const;`],
    [
        "a last field with no semicolon whose type is a name",
        `export type RunnerErrorCode = { code: "${RUNNER_CODE}"; origin: Origin };`,
    ],
    [
        "a type declared before its constant object",
        `export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];\nexport const RunnerErrorCode = { Only: "${RUNNER_CODE}" } as const;`,
    ],
];

describe("Using the error anchor check", () => {
    let root = "";

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "error-anchor-shapes-"));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    describe("given a declaration with a shorthand member the check does not list", () => {
        describe("when the check runs", () => {
            test("then it should report one problem naming both the set and the declaration", () => {
                plantTree(
                    root,
                    `export const RunnerErrorCode = { Only: "${RUNNER_CODE}", MovedCodes } as const;`,
                );

                const problems = checkErrorAnchors(root);

                assert.equal(problems.length, 1, problems.join("\n"));
                assert.match(problems[0] ?? "", /MovedCodes/);
                assert.match(
                    problems[0] ?? "",
                    /RunnerErrorCode in packages\/contracts\/src\/errors\/RunnerError\.ts/,
                );
            });
        });
    });

    describe("given a declaration with one heading for its code", () => {
        for (const [shape, declaration] of DECLARATIONS_THE_CHECK_ACCEPTS) {
            describe(`when the declaration has ${shape}`, () => {
                test("then it should report nothing", () => {
                    plantTree(root, declaration);

                    assert.deepEqual(checkErrorAnchors(root), []);
                });
            });
        }
    });
});
