// The golden freeze across a folder move: goldens moving from golden/ to test/golden/, and both
// folders guarded. On a throw-away Git repository whose defect log holds rows 3 and 7.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkGoldenChanges } from "../../tools/CheckGoldenChanges.ts";
import {
    createGitRepository,
    type FixtureCommit,
    type GitRepository,
} from "../support/git-repository.ts";

const DEFECT_LOG = `# Defects

| Id | Suspected problem |
|---|---|
| 3 | A problem |
| 7 | Another problem |
`;

const NO_DEFECT_NAMED = /no "Defect: <number>" trailer/;
const LONG_GOLDEN = '{ "step": "fill the signup form" }\n'.repeat(400);

describe("Using the golden changes check across both golden folders", () => {
    let repository: GitRepository;
    let freeze: string;

    const problemsOf = (range: string): readonly string[] =>
        checkGoldenChanges(range, freeze, repository.root);

    // The problems of one new commit, judged on its own.
    const problemsOfCommit = (fixture: FixtureCommit): readonly string[] => {
        const previous = repository.git("rev-parse", "HEAD");
        const commit = repository.commit(fixture);
        return problemsOf(`${previous}..${commit}`);
    };

    // Commits goldens outside the judged range, so each scenario moves files of its own.
    const seedGoldens = (files: Readonly<Record<string, string>>): void => {
        repository.commit({ files, message: "Seed goldens\n\nDefect: 3" });
    };

    before(() => {
        repository = createGitRepository();
        repository.commit({
            files: { "docs/decisions/refactor-defects.md": DEFECT_LOG },
            message: "Start the fixture project",
        });
        freeze = repository.commit({
            files: { "golden/reset.json": "reset\n" },
            message: "Reset the goldens",
        });
    });

    after(() => {
        repository.dispose();
    });

    describe("given a commit after the freeze that moves a golden to test/golden with identical bytes", () => {
        describe("and its message has no trailer", () => {
            describe("when the check reads it", () => {
                test("then it should pass", () => {
                    seedGoldens({ "golden/moves/plain.json": "plain\n" });
                    const problems = problemsOfCommit({
                        files: { "test/golden/moves/plain.json": "plain\n" },
                        removed: ["golden/moves/plain.json"],
                        message: "Move a golden",
                    });
                    assert.deepEqual(problems, []);
                });
            });
        });

        describe("and the commit changes files that are not goldens as well", () => {
            describe("when the check reads it", () => {
                test("then it should pass", () => {
                    seedGoldens({ "golden/moves/beside-code.json": "beside code\n" });
                    const problems = problemsOfCommit({
                        files: {
                            "test/golden/moves/beside-code.json": "beside code\n",
                            "test/support/moved-helper.ts": "export {};\n",
                        },
                        removed: ["golden/moves/beside-code.json"],
                        message: "Move a golden and its helper",
                    });
                    assert.deepEqual(problems, []);
                });
            });
        });

        describe("and the commit removes another golden with no matching new file", () => {
            describe("when the check reads it", () => {
                test("then it should fail, naming the removed golden", () => {
                    seedGoldens({
                        "golden/moves/kept.json": "kept\n",
                        "golden/moves/lost.json": "lost\n",
                    });
                    const problems = problemsOfCommit({
                        files: { "test/golden/moves/kept.json": "kept\n" },
                        removed: ["golden/moves/kept.json", "golden/moves/lost.json"],
                        message: "Move one golden and lose another",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /golden\/moves\/lost\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });

        describe("and the commit edits another golden in place", () => {
            describe("when the check reads it", () => {
                test("then it should fail, naming the edited golden", () => {
                    seedGoldens({
                        "golden/moves/still.json": "still\n",
                        "golden/moves/edited.json": "before\n",
                    });
                    const problems = problemsOfCommit({
                        files: {
                            "test/golden/moves/still.json": "still\n",
                            "golden/moves/edited.json": "after\n",
                        },
                        removed: ["golden/moves/still.json"],
                        message: "Move one golden and edit another",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /golden\/moves\/edited\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });
    });

    describe("given a commit after the freeze that moves a golden to test/golden and changes its bytes", () => {
        describe("and its message has no trailer", () => {
            describe("when the check reads it", () => {
                test("then it should fail, naming the golden", () => {
                    seedGoldens({ "golden/edits/plain.json": "before\n" });
                    const problems = problemsOfCommit({
                        files: { "test/golden/edits/plain.json": "after\n" },
                        removed: ["golden/edits/plain.json"],
                        message: "Move and edit a golden",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /golden\/edits\/plain\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });

        describe("and Git would still call it a rename, at a similarity under 100%", () => {
            describe("when the check reads it", () => {
                test("then it should fail", () => {
                    seedGoldens({ "golden/edits/long.json": LONG_GOLDEN });
                    const previous = repository.git("rev-parse", "HEAD");
                    const commit = repository.commit({
                        files: { "test/golden/edits/long.json": `${LONG_GOLDEN}\n` },
                        removed: ["golden/edits/long.json"],
                        message: "Move a golden and add one byte",
                    });
                    const detected = repository.git(
                        "diff-tree",
                        "--no-commit-id",
                        "--name-status",
                        "-M",
                        "-r",
                        commit,
                    );
                    assert.match(detected, /^R(?!100)\d+\t/);
                    const problems = problemsOf(`${previous}..${commit}`);
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });

        describe("and two goldens swap their contents as they move", () => {
            describe("when the check reads it", () => {
                test("then it should fail", () => {
                    seedGoldens({
                        "golden/edits/first.json": "first\n",
                        "golden/edits/second.json": "second\n",
                    });
                    const problems = problemsOfCommit({
                        files: {
                            "test/golden/edits/first.json": "second\n",
                            "test/golden/edits/second.json": "first\n",
                        },
                        removed: ["golden/edits/first.json", "golden/edits/second.json"],
                        message: "Move two goldens and swap them",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });

        describe("and its trailer names a row of the defect log", () => {
            describe("when the check reads it", () => {
                test("then it should pass", () => {
                    seedGoldens({ "golden/edits/named.json": "before\n" });
                    const problems = problemsOfCommit({
                        files: { "test/golden/edits/named.json": "after\n" },
                        removed: ["golden/edits/named.json"],
                        message: "Move and fix a golden\n\nDefect: 7",
                    });
                    assert.deepEqual(problems, []);
                });
            });
        });
    });

    describe("given a commit after the freeze that moves a golden to test/golden under another name", () => {
        describe("when it names no defect", () => {
            test("then it should fail, though the bytes are identical", () => {
                seedGoldens({ "golden/renames/old-name.json": "same bytes\n" });
                const problems = problemsOfCommit({
                    files: { "test/golden/renames/new-name.json": "same bytes\n" },
                    removed: ["golden/renames/old-name.json"],
                    message: "Rename a golden as it moves",
                });
                assert.equal(problems.length, 1);
                assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
            });
        });
    });

    describe("given a commit after the freeze that copies a golden to test/golden and keeps the original", () => {
        describe("when it names no defect", () => {
            test("then it should fail, naming the new golden", () => {
                seedGoldens({ "golden/copies/original.json": "original\n" });
                const problems = problemsOfCommit({
                    files: { "test/golden/copies/original.json": "original\n" },
                    message: "Copy a golden",
                });
                assert.equal(problems.length, 1);
                assert.match(problems[0] ?? "", /test\/golden\/copies\/original\.json/);
            });
        });
    });

    describe("given a commit after the freeze that moves a golden out of the golden folders", () => {
        describe("and it starts in golden", () => {
            describe("when it names no defect", () => {
                test("then it should fail, naming the golden that has gone", () => {
                    seedGoldens({ "golden/leaves/from-old.json": "leaving\n" });
                    const problems = problemsOfCommit({
                        files: { "docs/leaves/from-old.json": "leaving\n" },
                        removed: ["golden/leaves/from-old.json"],
                        message: "Move a golden to the docs",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /golden\/leaves\/from-old\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });

        describe("and it starts in test/golden", () => {
            describe("when it names no defect", () => {
                test("then it should fail, naming the golden that has gone", () => {
                    seedGoldens({ "test/golden/leaves/from-new.json": "leaving\n" });
                    const problems = problemsOfCommit({
                        files: { "docs/leaves/from-new.json": "leaving\n" },
                        removed: ["test/golden/leaves/from-new.json"],
                        message: "Move a golden to the docs",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /test\/golden\/leaves\/from-new\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });
        });
    });

    describe("given a commit after the freeze that adds a new golden", () => {
        describe("and it adds it under golden", () => {
            describe("when it names no defect", () => {
                test("then it should fail, naming the new golden", () => {
                    const problems = problemsOfCommit({
                        files: { "golden/added/under-old.json": "new\n" },
                        message: "Add a golden",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /golden\/added\/under-old\.json/);
                });
            });
        });

        describe("and it adds it under test/golden", () => {
            describe("when it names no defect", () => {
                test("then it should fail, naming the new golden", () => {
                    const problems = problemsOfCommit({
                        files: { "test/golden/added/no-trailer.json": "new\n" },
                        message: "Add a golden",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /test\/golden\/added\/no-trailer\.json/);
                });
            });

            describe("when its trailer names a row of the defect log", () => {
                test("then it should pass", () => {
                    const problems = problemsOfCommit({
                        files: { "test/golden/added/named.json": "new\n" },
                        message: "Add a golden\n\nDefect: 3",
                    });
                    assert.deepEqual(problems, []);
                });
            });
        });
    });

    describe("given a golden already at test/golden", () => {
        describe("and a commit after the freeze changes it", () => {
            describe("when the commit names no defect", () => {
                test("then it should fail, naming the file", () => {
                    seedGoldens({ "test/golden/guarded/changed.json": "before\n" });
                    const problems = problemsOfCommit({
                        files: { "test/golden/guarded/changed.json": "after\n" },
                        message: "Change a golden",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /test\/golden\/guarded\/changed\.json/);
                    assert.match(problems[0] ?? "", NO_DEFECT_NAMED);
                });
            });

            describe("when its trailer names a row of the defect log", () => {
                test("then it should pass", () => {
                    seedGoldens({ "test/golden/guarded/fixed.json": "before\n" });
                    const problems = problemsOfCommit({
                        files: { "test/golden/guarded/fixed.json": "after\n" },
                        message: "Fix a golden\n\nDefect: 3",
                    });
                    assert.deepEqual(problems, []);
                });
            });
        });

        describe("and a commit after the freeze removes it with no matching new file", () => {
            describe("when the commit names no defect", () => {
                test("then it should fail, naming the file", () => {
                    seedGoldens({ "test/golden/guarded/removed.json": "before\n" });
                    const problems = problemsOfCommit({
                        removed: ["test/golden/guarded/removed.json"],
                        message: "Drop a golden",
                    });
                    assert.equal(problems.length, 1);
                    assert.match(problems[0] ?? "", /test\/golden\/guarded\/removed\.json/);
                });
            });
        });
    });
});
