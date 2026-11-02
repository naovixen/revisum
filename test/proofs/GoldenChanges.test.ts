// The golden freeze, on a throw-away Git repository, so it never depends on this repository's own
// history. The defect log there holds rows 3 and 7.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkGoldenChanges, readDefectNumbers } from "../../tools/CheckGoldenChanges.ts";
import { createGitRepository, type GitRepository } from "../support/git-repository.ts";
import { REPOSITORY_ROOT } from "../support/repository.ts";

const DEFECT_LOG = `# Defects

| Finding | Do |
|---|---|
| Clearly wrong | Fix now |

| Id | Suspected problem |
|---|---|
| 3 | A problem |
| 7 | Another problem |
`;

const GOLDEN_FILE = "golden/plans/signup.json";

describe("Using the golden changes check", () => {
    let repository: GitRepository;
    let freeze: string;

    const problemsOf = (range: string): readonly string[] =>
        checkGoldenChanges(range, freeze, repository.root);

    // The problems of a new commit that changes a golden with this message.
    const problemsOfGoldenCommit = (message: string, content: string): readonly string[] => {
        const previous = repository.git("rev-parse", "HEAD");
        const commit = repository.commit({ files: { [GOLDEN_FILE]: content }, message });
        return problemsOf(`${previous}..${commit}`);
    };

    before(() => {
        repository = createGitRepository();
        repository.commit({
            files: { "docs/decisions/refactor-defects.md": DEFECT_LOG },
            message: "Start the fixture project",
        });
        freeze = repository.commit({
            files: { [GOLDEN_FILE]: "reset\n", "golden/other.json": "other\n" },
            message: "Reset the goldens",
        });
    });

    after(() => {
        repository.dispose();
    });

    describe("given the freeze commit itself changes a golden", () => {
        describe("when the range reaches back over it", () => {
            test("then it should judge nothing", () => {
                const first = repository.git("rev-list", "--max-parents=0", "HEAD");
                assert.deepEqual(problemsOf(`${first}..${freeze}`), []);
            });
        });
    });

    describe("given a commit after the freeze that changes a golden", () => {
        describe("and its message has no trailer", () => {
            describe("when the check reads it", () => {
                test("then it should fail, naming the commit and the file", () => {
                    const problems = problemsOfGoldenCommit("Change a golden", "no trailer\n");
                    assert.equal(problems.length, 1);
                    assert.match(
                        problems[0] ?? "",
                        /^commit [0-9a-f]{12} changes golden\/plans\/signup\.json/,
                    );
                    assert.match(problems[0] ?? "", /no "Defect: <number>" trailer/);
                });
            });
        });

        describe("and its trailer names a row of the defect log", () => {
            describe("when the check reads it", () => {
                test("then it should pass", () => {
                    const message = "Fix a defect\n\nDefect: 7\nAgent: claude-code/2.1.312";
                    assert.deepEqual(problemsOfGoldenCommit(message, "fixed\n"), []);
                });
            });
        });

        describe("and its trailer names a number with no row", () => {
            describe("when the check reads it", () => {
                test("then it should fail, naming the number", () => {
                    const problems = problemsOfGoldenCommit(
                        "Change a golden\n\nDefect: 99",
                        "unknown row\n",
                    );
                    assert.match(problems[0] ?? "", /names no row .*: 99$/);
                });
            });
        });

        describe("and one trailer names a row and another doesn't", () => {
            describe("when the check reads it", () => {
                test("then it should fail", () => {
                    const message = "Change a golden\n\nDefect: 3\nDefect: 99";
                    assert.equal(problemsOfGoldenCommit(message, "one good row\n").length, 1);
                });
            });
        });

        describe("and its trailer holds something other than a number", () => {
            describe("when the check reads it", () => {
                test("then it should fail", () => {
                    const message = "Change a golden\n\nDefect: see row 3";
                    assert.equal(problemsOfGoldenCommit(message, "not a number\n").length, 1);
                });
            });
        });

        describe('and "Defect:" appears only in the body, not the trailer block', () => {
            describe("when the check reads it", () => {
                test("then it should fail", () => {
                    const message = "Change a golden\n\nDefect: 3\n\nThat row is close enough.";
                    assert.equal(problemsOfGoldenCommit(message, "in the body\n").length, 1);
                });
            });
        });
    });

    describe("given a commit after the freeze that removes a golden", () => {
        describe("when it names no defect", () => {
            test("then it should fail", () => {
                const previous = repository.git("rev-parse", "HEAD");
                const commit = repository.commit({
                    removed: ["golden/other.json"],
                    message: "Drop a golden",
                });
                assert.equal(problemsOf(`${previous}..${commit}`).length, 1);
            });
        });
    });

    describe("given a commit after the freeze that changes no golden", () => {
        describe("when it names no defect", () => {
            test("then it should pass", () => {
                const previous = repository.git("rev-parse", "HEAD");
                const commit = repository.commit({
                    files: { "packages/app.ts": "export {};\n" },
                    message: "Change the code",
                });
                assert.deepEqual(problemsOf(`${previous}..${commit}`), []);
            });
        });
    });

    describe("given a merge of a branch whose commit names its defect", () => {
        describe("when the merge itself changes no golden", () => {
            test("then it should pass with no trailer on the merge", () => {
                const start = repository.git("rev-parse", "HEAD");
                repository.git("checkout", "-q", "-b", "fix-branch");
                repository.commit({
                    files: { [GOLDEN_FILE]: "from the branch\n" },
                    message: "Fix\n\nDefect: 3",
                });
                repository.git("checkout", "-q", "-");
                repository.commit({
                    files: { "packages/other.ts": "export {};\n" },
                    message: "Other work",
                });
                repository.git("merge", "-q", "--no-ff", "-m", "Merge the fix", "fix-branch");
                assert.deepEqual(problemsOf(`${start}..HEAD`), []);
            });
        });
    });

    describe("given a merge that adds a golden of its own", () => {
        describe("when the merge names no defect", () => {
            test("then it should fail, naming the golden", () => {
                const start = repository.git("rev-parse", "HEAD");
                repository.git("checkout", "-q", "-b", "quiet-branch");
                repository.commit({
                    files: { "packages/quiet.ts": "export {};\n" },
                    message: "Quiet work",
                });
                repository.git("checkout", "-q", "-");
                repository.commit({
                    files: { "packages/main.ts": "export {};\n" },
                    message: "Main work",
                });
                repository.git("merge", "-q", "--no-ff", "--no-commit", "quiet-branch");
                repository.write("golden/slipped-in.json", "slipped in\n");
                repository.git("add", "golden/slipped-in.json");
                repository.git("commit", "-q", "-m", "Merge the quiet work");
                const problems = problemsOf(`${start}..HEAD`);
                assert.equal(problems.length, 1);
                assert.match(problems[0] ?? "", /golden\/slipped-in\.json/);
            });
        });
    });

    describe("given a freeze commit Git doesn't know", () => {
        describe("when the check runs", () => {
            test("then it should stop with an error rather than pass", () => {
                const unknownCommit = "0123456789012345678901234567890123456789";
                assert.throws(() =>
                    checkGoldenChanges("HEAD~1..HEAD", unknownCommit, repository.root),
                );
            });
        });
    });

    describe("given the repository's own defect log", () => {
        describe("when its rows are read", () => {
            test("then it should find every numbered row and no table heading", () => {
                const log = readFileSync(
                    join(REPOSITORY_ROOT, "docs", "decisions", "refactor-defects.md"),
                    "utf8",
                );
                const numbers = readDefectNumbers(log);
                assert.ok(numbers.has("1"));
                assert.ok(numbers.size >= 22, `only ${numbers.size} rows`);
                assert.ok([...numbers].every((number) => /^\d+$/.test(number)));
            });
        });
    });
});
