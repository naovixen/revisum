// docs/glossary.md maps each domain term to its code name, and tools/repo-rules/docs/CheckGlossary.ts keeps it
// true in the lint:
//   - every code name in the Domain terms and Metrics tables resolves to an exported declaration,
//     a declared string or property name, or (when it looks like a path) a file in the repository;
//     a row whose "Where" says only "planned" is skipped, a partly planned one is checked;
//   - every type the engine's public API exports, through `export *` into contracts, is listed;
//   - the Standard names table equals the naming lint's standardNames.
// Each test changes the glossary in a throw-away copy of the repository and runs the lint.
import { after, before, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";
import { assertLintFails, assertLintPasses, lintWithEdits } from "../support/WithEdits.ts";

const GLOSSARY_PATH = "docs/glossary.md";
const ANCHOR_ROW = "| Engine | `engine` package |";
const TIMEOUT = 300_000;

const ONLY_THE_RULE = { rule: RepositoryRuleName.Glossary };

let scratch: ScratchRepository;
before(() => {
    scratch = copyRepository();
});
after(() => {
    scratch.dispose();
});

// The glossary with one extra Domain terms row, placed before the Engine row.
const withRow =
    (row: string) =>
    (text: string): string => {
        if (!text.includes(ANCHOR_ROW)) {
            throw new Error(`${GLOSSARY_PATH} has no Engine row to place the new row beside`);
        }
        return text.replace(ANCHOR_ROW, `${row}\n${ANCHOR_ROW}`);
    };

// The glossary with one exact piece of text removed.
const without =
    (removed: string) =>
    (text: string): string => {
        if (!text.includes(removed)) {
            throw new Error(`${GLOSSARY_PATH} does not hold ${JSON.stringify(removed)}`);
        }
        return text.replace(removed, "");
    };

test(
    "control: the unchanged copy of the repository passes every lint command",
    { timeout: TIMEOUT },
    () => {
        assertLintPasses(scratch.lint());
    },
);

// ---- Code names resolve -------------------------------------------------------------------------

test(
    "the lint fails on a row whose code name is no exported declaration",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            {
                [GLOSSARY_PATH]: withRow(
                    "| Planted term | `plantedMissingExport` | `engine`, exists | A term whose code name names nothing |",
                ),
            },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["plantedMissingExport"]);
    },
);

test(
    "the lint fails on a partly planned row whose existing code name is missing",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            {
                [GLOSSARY_PATH]: withRow(
                    "| Planted term | `plantedMissingExport` | `engine`, exists; driver planned | A term whose code name names nothing |",
                ),
            },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["plantedMissingExport"]);
    },
);

test(
    "the lint fails on a row whose code name is a path that does not exist",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            {
                [GLOSSARY_PATH]: withRow(
                    "| Planted tool | `tools/planted-missing-tool.ts` | `tools`, exists | A tool that is not there |",
                ),
            },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["tools/planted-missing-tool.ts"]);
    },
);

test(
    'counter-example: a row whose "Where" says only "planned" is not checked',
    { timeout: TIMEOUT },
    () => {
        assertLintPasses(
            lintWithEdits(scratch, {
                [GLOSSARY_PATH]: withRow(
                    "| Planted term | `plantedMissingExport` | planned | A term whose code is still to come |",
                ),
            }),
        );
    },
);

// ---- The engine's public API is listed ----------------------------------------------------------

test(
    "the lint fails when an exported engine type is taken out of the glossary",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            {
                [GLOSSARY_PATH]: (text) =>
                    text
                        .split("\n")
                        .filter((line) => !line.includes("`AiText`"))
                        .join("\n"),
            },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["AiText"]);
    },
);

test(
    "the lint fails when a contracts type the engine re-exports is taken out of the glossary",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            { [GLOSSARY_PATH]: without("`LeakScanner`, ") },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["LeakScanner"]);
    },
);

// ---- Standard names -----------------------------------------------------------------------------

test(
    "the lint fails when a standard name is dropped from the glossary",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            { [GLOSSARY_PATH]: without("| mcp | Model Context Protocol |\n") },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["mcp"]);
    },
);

test("the lint fails when a standard name is given another full name", { timeout: TIMEOUT }, () => {
    const outcome = lintWithEdits(
        scratch,
        {
            [GLOSSARY_PATH]: (text) =>
                without("| jwt | JSON Web Token |")(text).replace(
                    "| oidc | OpenID Connect |",
                    "| oidc | OpenID Connect |\n| jwt | JSON Web Tokens |",
                ),
        },
        ONLY_THE_RULE,
    );
    assertLintFails(outcome, ["jwt"]);
});
