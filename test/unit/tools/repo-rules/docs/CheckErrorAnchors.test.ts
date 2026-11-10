// The check keeps errors#<code> links working, and reads the codes out of source text. The trees here
// are planted on disk, so what the check reads is real files, and each union gets a one-line stand-in
// unless a test gives it something else.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { REPOSITORY_ROOT } from "#test-support/repository/RepositoryRoot.ts";
import {
    ERROR_CODE_UNIONS,
    ERRORS_PAGE,
    checkErrorAnchors,
    readDeclaredCodes,
    unlistedBorrowedSets,
} from "../../../../../tools/repo-rules/docs/CheckErrorAnchors.ts";
import { codeTokens } from "../../../../../tools/repo-rules/ListSourceFiles.ts";

const declaredIn = (source: string, name = "Codes") => readDeclaredCodes(codeTokens(source), name);

const codeOf = (unionName: string): string => `${unionName}-code`;

const headingsOfEveryUnion = (): readonly string[] =>
    ERROR_CODE_UNIONS.map((union) => `## ${codeOf(union.name)}`);

type PlantedTree = {
    readonly declarations?: Readonly<Record<string, string>>;
    readonly page?: string;
};

function plantTree(root: string, tree: PlantedTree): void {
    const sourceByFile = new Map<string, string>();
    for (const union of ERROR_CODE_UNIONS) {
        const declaration =
            tree.declarations?.[union.name] ??
            `export const ${union.name} = { Only: "${codeOf(union.name)}" } as const;`;
        sourceByFile.set(union.file, `${sourceByFile.get(union.file) ?? ""}${declaration}\n`);
    }
    for (const [file, source] of sourceByFile) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), source);
    }
    if (tree.page !== undefined) {
        mkdirSync(dirname(join(root, ERRORS_PAGE)), { recursive: true });
        writeFileSync(join(root, ERRORS_PAGE), tree.page);
    }
}

const pageWith = (headings: readonly string[]): string => `# Errors\n\n${headings.join("\n\n")}\n`;

function assertOneProblemNaming(problems: readonly string[], fragments: readonly string[]): void {
    assert.equal(problems.length, 1, problems.join("\n"));
    for (const fragment of fragments) {
        assert.ok(
            problems.join("").includes(fragment),
            `"${fragment}" not in: ${problems.join("")}`,
        );
    }
}

describe("Using the declared codes reader", () => {
    describe("given a declaration of string codes", () => {
        describe("when it is a union type", () => {
            test("then it should read each code and no borrowed set", () => {
                assert.deepEqual(declaredIn("export type Codes = 'first' | 'second';"), {
                    codes: ["first", "second"],
                    borrowedSets: [],
                });
            });
        });

        describe("when it is a const list", () => {
            test("then it should read each code and no borrowed set", () => {
                assert.deepEqual(declaredIn("const Codes = ['first', 'second'] as const;"), {
                    codes: ["first", "second"],
                    borrowedSets: [],
                });
            });
        });

        describe("when it is a constant object", () => {
            test("then it should read the values, not the keys", () => {
                assert.deepEqual(
                    declaredIn("const Codes = { First: 'first', Second: 'second' } as const;"),
                    { codes: ["first", "second"], borrowedSets: [] },
                );
            });
        });

        describe("when another declaration follows it", () => {
            test("then it should stop at the semicolon that ends it", () => {
                assert.deepEqual(
                    declaredIn("type Codes = 'first'; type Others = 'second' | Elsewhere;"),
                    { codes: ["first"], borrowedSets: [] },
                );
            });
        });

        describe("when a comment inside it quotes a code and sits beside a borrowed set", () => {
            test("then it should read the code around the comment and still see the set", () => {
                assert.deepEqual(
                    declaredIn(
                        "const Codes = {\n  // once 'retired'\n  Key: SharedCodes /* 'old' */,\n  First: 'first',\n} as const;",
                    ),
                    { codes: ["first"], borrowedSets: ["SharedCodes"] },
                );
            });
        });
    });

    describe("given a declaration that takes codes from another set", () => {
        describe("when it spreads the set", () => {
            test("then it should record the set beside its own codes", () => {
                assert.deepEqual(
                    declaredIn("const Codes = { ...SharedCodes, Own: 'own' } as const;"),
                    { codes: ["own"], borrowedSets: ["SharedCodes"] },
                );
            });
        });

        describe("when it takes one member of the set", () => {
            test("then it should record only the set, not the member", () => {
                assert.deepEqual(
                    declaredIn("const Codes = { Own: SharedCodes.Member, Next: 'next' } as const;"),
                    { codes: ["next"], borrowedSets: ["SharedCodes"] },
                );
            });
        });

        describe("when it spreads a member of a set", () => {
            test("then it should record only the set, not the member", () => {
                assert.deepEqual(declaredIn("const Codes = { ...SharedCodes.Member } as const;"), {
                    codes: [],
                    borrowedSets: ["SharedCodes"],
                });
            });
        });

        describe("when a key takes the set as its value, followed by another key", () => {
            test("then it should record the set, not the keys", () => {
                assert.deepEqual(
                    declaredIn("const Codes = { Key: SharedCodes, Next: 'next' } as const;"),
                    { codes: ["next"], borrowedSets: ["SharedCodes"] },
                );
            });
        });

        describe("when the last key takes the set as its value", () => {
            test("then it should record the set, not the key", () => {
                assert.deepEqual(declaredIn("const Codes = { Key: SharedCodes } as const;"), {
                    codes: [],
                    borrowedSets: ["SharedCodes"],
                });
            });
        });

        describe("when a union names the set after a bar", () => {
            test("then it should record the set beside its own codes", () => {
                assert.deepEqual(declaredIn("type Codes = 'own' | SharedCodes;"), {
                    codes: ["own"],
                    borrowedSets: ["SharedCodes"],
                });
            });
        });

        describe("when a union names the set first", () => {
            test("then it should record the set beside its own codes", () => {
                assert.deepEqual(declaredIn("type Codes = SharedCodes | 'own';"), {
                    codes: ["own"],
                    borrowedSets: ["SharedCodes"],
                });
            });
        });

        describe("when it names the same set twice", () => {
            test("then it should record the set once", () => {
                assert.deepEqual(
                    declaredIn(
                        "const Codes = { ...SharedCodes, Own: SharedCodes.Member } as const;",
                    ),
                    { codes: [], borrowedSets: ["SharedCodes"] },
                );
            });
        });
    });

    describe("given a type with fields", () => {
        describe("when a field's type is a name followed by a semicolon", () => {
            test("then it should not count that name as a borrowed set", () => {
                assert.deepEqual(declaredIn("type Codes = { origin: Origin; code: 'first' };"), {
                    codes: ["first"],
                    borrowedSets: [],
                });
            });
        });
    });

    describe("given source that does not declare the name", () => {
        describe("when the name is only mentioned", () => {
            test("then it should give undefined", () => {
                assert.equal(
                    declaredIn("const Others = Codes; type Rest = Codes | 'first';"),
                    undefined,
                );
            });
        });

        describe("when another name is declared", () => {
            test("then it should give undefined", () => {
                assert.equal(declaredIn("type Others = 'first';"), undefined);
            });
        });

        describe("when the name is declared with no value and a later declaration holds codes", () => {
            test("then it should give undefined, not the later declaration's codes", () => {
                assert.equal(
                    declaredIn("declare const Codes: Shape; const Others = 'first';"),
                    undefined,
                );
            });
        });
    });
});

describe("Using the unlisted borrowed sets filter", () => {
    describe("given a declaration that borrows two sets", () => {
        const declared = { codes: ["own"], borrowedSets: ["Listed", "Unlisted"] };

        describe("when one of them is listed", () => {
            test("then it should give only the other", () => {
                assert.deepEqual(unlistedBorrowedSets(declared, ["Listed", "Elsewhere"]), [
                    "Unlisted",
                ]);
            });
        });

        describe("when both are listed", () => {
            test("then it should give nothing", () => {
                assert.deepEqual(unlistedBorrowedSets(declared, ["Unlisted", "Listed"]), []);
            });
        });

        describe("when neither is listed", () => {
            test("then it should give both", () => {
                assert.deepEqual(unlistedBorrowedSets(declared, []), ["Listed", "Unlisted"]);
            });
        });
    });
});

describe("Using the error anchor check", () => {
    let root = "";

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "error-anchors-"));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    describe("given a tree with one heading for every code", () => {
        describe("when the check runs", () => {
            test("then it should report nothing", () => {
                plantTree(root, { page: pageWith(headingsOfEveryUnion()) });

                assert.deepEqual(checkErrorAnchors(root), []);
            });
        });

        describe("when the page has Windows line endings", () => {
            test("then it should report nothing", () => {
                plantTree(root, {
                    page: pageWith(headingsOfEveryUnion()).replaceAll("\n", "\r\n"),
                });

                assert.deepEqual(checkErrorAnchors(root), []);
            });
        });
    });

    describe("given a declaration that holds no codes of its own", () => {
        const headingsWithoutItsCode = headingsOfEveryUnion().filter(
            (heading) => heading !== `## ${codeOf("RunnerErrorCode")}`,
        );

        describe("when it only spreads a set the check lists", () => {
            test("then it should report nothing", () => {
                plantTree(root, {
                    declarations: {
                        RunnerErrorCode:
                            "export const RunnerErrorCode = { ...ContainerRefusalCode } as const;",
                    },
                    page: pageWith(headingsWithoutItsCode),
                });

                assert.deepEqual(checkErrorAnchors(root), []);
            });
        });

        describe("when it holds nothing at all", () => {
            test("then it should say it cannot read that union", () => {
                plantTree(root, {
                    declarations: {
                        RunnerErrorCode: "export const RunnerErrorCode = {} as const;",
                    },
                    page: pageWith(headingsWithoutItsCode),
                });

                const problems = checkErrorAnchors(root);

                assert.equal(problems.length, 1, problems.join("\n"));
                assert.match(
                    problems[0] ?? "",
                    /^cannot read the codes of RunnerErrorCode from packages\/contracts\/src\/errors\/RunnerError\.ts/,
                );
            });
        });
    });

    describe("given a union's declaration has gone from its file", () => {
        describe("when the check runs", () => {
            test("then it should say it cannot read that union, and call its heading an orphan", () => {
                plantTree(root, {
                    declarations: {
                        SinkErrorCode: "export const Renamed = { Only: 'moved' } as const;",
                    },
                    page: pageWith(headingsOfEveryUnion()),
                });

                const problems = checkErrorAnchors(root);

                assert.equal(problems.length, 2, problems.join("\n"));
                assert.match(
                    problems[0] ?? "",
                    /^cannot read the codes of SinkErrorCode from packages\/contracts\/src\/events\/AuditEventKind\.ts/,
                );
                assert.match(
                    problems[1] ?? "",
                    new RegExp(`"## ${codeOf("SinkErrorCode")}" heading`),
                );
            });
        });
    });

    describe("given a declaration that borrows a set the check does not list", () => {
        describe("when the check runs", () => {
            test("then it should report one problem naming both the set and the declaration", () => {
                plantTree(root, {
                    declarations: {
                        RunnerErrorCode: `export const RunnerErrorCode = { ...MovedCodes, Only: "${codeOf("RunnerErrorCode")}" } as const;`,
                    },
                    page: pageWith(headingsOfEveryUnion()),
                });

                const problems = checkErrorAnchors(root);

                assertOneProblemNaming(problems, [
                    "MovedCodes",
                    "RunnerErrorCode in packages/contracts/src/errors/RunnerError.ts",
                ]);
            });
        });
    });

    describe("given a code with no heading", () => {
        const headingsWithoutOneCode = headingsOfEveryUnion().filter(
            (heading) => heading !== `## ${codeOf("SinkErrorCode")}`,
        );

        describe("when the page simply leaves it out", () => {
            test("then it should report one problem naming the code and its union", () => {
                plantTree(root, { page: pageWith(headingsWithoutOneCode) });

                const problems = checkErrorAnchors(root);

                assertOneProblemNaming(problems, [
                    `has no "## ${codeOf("SinkErrorCode")}" heading`,
                    "SinkErrorCode in packages/contracts/src/events/AuditEventKind.ts",
                ]);
            });
        });

        describe("when the only heading for it has more words after the code", () => {
            test("then it should report the code as having no heading", () => {
                plantTree(root, {
                    page: pageWith([
                        ...headingsWithoutOneCode,
                        `## ${codeOf("SinkErrorCode")} and more`,
                    ]),
                });

                const problems = checkErrorAnchors(root);

                assertOneProblemNaming(problems, [
                    `has no "## ${codeOf("SinkErrorCode")}" heading`,
                ]);
            });
        });
    });

    describe("given a heading no union holds", () => {
        describe("when the check runs", () => {
            test("then it should report one problem naming the heading", () => {
                plantTree(root, { page: pageWith([...headingsOfEveryUnion(), "## retired-code"]) });

                const problems = checkErrorAnchors(root);

                assertOneProblemNaming(problems, [
                    '"## retired-code" heading',
                    "no error-code union holds retired-code",
                ]);
            });
        });
    });

    describe("given a tree with no errors page", () => {
        describe("when the check runs", () => {
            test("then it should say the page is missing as well as each heading", () => {
                plantTree(root, {});

                const problems = checkErrorAnchors(root);

                assert.equal(problems[0], `${ERRORS_PAGE} is missing`);
                assert.equal(problems.length, ERROR_CODE_UNIONS.length + 1, problems.join("\n"));
            });
        });
    });

    describe("given a tree with a union's file missing", () => {
        describe("when the check runs", () => {
            test("then it should say it cannot read that union", () => {
                plantTree(root, { page: pageWith(headingsOfEveryUnion()) });
                rmSync(join(root, "packages/engine/src/run/seal/BuildManifest.ts"));

                const problems = checkErrorAnchors(root);

                assert.ok(
                    problems.some((problem) =>
                        problem.startsWith(
                            "cannot read the codes of ReplayErrorCode from packages/engine/src/run/seal/BuildManifest.ts",
                        ),
                    ),
                    problems.join("\n"),
                );
            });
        });
    });

    describe("given this repository", () => {
        describe("when the check runs", () => {
            test("then it should report nothing", () => {
                assert.deepEqual(checkErrorAnchors(REPOSITORY_ROOT), []);
            });
        });
    });
});
