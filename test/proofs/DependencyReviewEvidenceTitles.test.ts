// A review's evidence can name one test, as "<file>#<name>", and that name is what the review rests
// on. So the title has to be there too, not only the file: a retitled test must fail the rule. The
// name is the one test results give a test, with the titles around it joined by " > ".
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../tools/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses, lintWithEdits } from "./scratch-edits.ts";
import type { LintOutcome } from "./scratch-repository.ts";
import { copyRepository, type ScratchRepository } from "./scratch-repository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.DependencyReviews };
const REVIEWS_PATH = "tools/dependency-reviews.ts";
const PLANTED_TEST = "test/proofs/planted-evidence.test.ts";

const CURRENT_TITLE = "the planted evidence holds";
const OLD_TITLE = "the planted evidence used to hold";

const withEvidence =
    (evidence: string) =>
    (text: string): string =>
        text.replace(
            /(['"])licences\.json\1,/,
            (listed) => `${listed}\n      ${JSON.stringify(evidence)},`,
        );

const FLAT_TEST = `import { test } from "node:test";\ntest("${CURRENT_TITLE}", () => {});\n`;
const NESTED_TEST = [
    'import { describe, test } from "node:test";',
    'describe("Using the planted thing", () => {',
    '    describe("given a copy", () => {',
    `        test("then it should say ${CURRENT_TITLE}", () => {});`,
    "    });",
    "});",
    "",
].join("\n");
const NESTED_NAME = `Using the planted thing > given a copy > then it should say ${CURRENT_TITLE}`;

describe("Using the dependency review lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    const lintEvidence = (testSource: string, evidence: string): LintOutcome =>
        lintWithEdits(
            scratch,
            { [PLANTED_TEST]: testSource, [REVIEWS_PATH]: withEvidence(evidence) },
            ONLY_THE_RULE,
        );

    describe("given evidence that names a test by file and title", () => {
        describe("when the test has since been retitled", () => {
            test("then it should fail, naming the old title", { timeout: TIMEOUT }, () => {
                assertLintFails(lintEvidence(FLAT_TEST, `${PLANTED_TEST}#${OLD_TITLE}`), [
                    "dependency review check: ",
                    "axe-core",
                    OLD_TITLE,
                ]);
            });
        });

        describe("when the old title survives only in a comment", () => {
            test("then it should fail, naming the old title", { timeout: TIMEOUT }, () => {
                assertLintFails(
                    lintEvidence(`// ${OLD_TITLE}\n${FLAT_TEST}`, `${PLANTED_TEST}#${OLD_TITLE}`),
                    ["dependency review check: ", OLD_TITLE],
                );
            });
        });

        describe("when a nested test's own title has since changed", () => {
            test("then it should fail, naming the old title", { timeout: TIMEOUT }, () => {
                const staleName = `Using the planted thing > given a copy > then it should say ${OLD_TITLE}`;
                assertLintFails(lintEvidence(NESTED_TEST, `${PLANTED_TEST}#${staleName}`), [
                    "dependency review check: ",
                    OLD_TITLE,
                ]);
            });
        });

        describe("when a title around a nested test has since changed", () => {
            test("then it should fail, naming the old title", { timeout: TIMEOUT }, () => {
                const staleName = `Using the planted thing > given an old copy > then it should say ${CURRENT_TITLE}`;
                assertLintFails(lintEvidence(NESTED_TEST, `${PLANTED_TEST}#${staleName}`), [
                    "dependency review check: ",
                    "given an old copy",
                ]);
            });
        });

        describe("when the test still has that title", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                assertLintPasses(lintEvidence(FLAT_TEST, `${PLANTED_TEST}#${CURRENT_TITLE}`));
            });
        });

        describe("when the title is single-quoted and wrapped onto its own line", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const wrapped = [
                    "import { test } from 'node:test';",
                    "test(",
                    `    '${CURRENT_TITLE}',`,
                    "    { timeout: 1000 },",
                    "    () => {},",
                    ");",
                    "",
                ].join("\n");
                assertLintPasses(lintEvidence(wrapped, `${PLANTED_TEST}#${CURRENT_TITLE}`));
            });
        });

        describe("when a nested test is named with the titles around it", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                assertLintPasses(lintEvidence(NESTED_TEST, `${PLANTED_TEST}#${NESTED_NAME}`));
            });
        });
    });

    describe("given evidence that names only a file", () => {
        describe("when the file exists", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                assertLintPasses(lintEvidence(FLAT_TEST, PLANTED_TEST));
            });
        });
    });

    describe("given evidence that is a web address with a fragment", () => {
        describe("when the rule runs", () => {
            test(
                "then it should pass, since only repository files are read",
                { timeout: TIMEOUT },
                () => {
                    assertLintPasses(lintEvidence(FLAT_TEST, "https://example.com/page#section"));
                },
            );
        });
    });
});
