// Most lint proofs run only the rule they test, so this file proves what they no longer see: that
// `npm run lint` runs every rule, that every check file in tools/ is a rule or is named here as
// not being one, and that each rule fails on its own planted violation.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
    RepositoryRuleName,
    REPOSITORY_RULES,
} from "../../tools/RunRepositoryRules.ts";
import { REPOSITORY_ROOT } from "../support/repository.ts";
import { describeRun, runTool } from "../support/tool-runs.ts";
import { editJson, lintWithEdits, withEdits, type FileEdit } from "./scratch-edits.ts";
import { copyRepository, type ScratchRepository } from "./scratch-repository.ts";

const TIMEOUT = 300_000;
const TOOLS_FOLDER = join(REPOSITORY_ROOT, "tools");
const RULE_NAMES = Object.values(RepositoryRuleName);

// Checks that read commits or a commit message, so CI runs each on its own against that input.
const CHECKS_THAT_ARE_NOT_REPOSITORY_RULES = [
    "check-commit-trailers.ts",
    "check-tests-apart.ts",
    "CheckGoldenChanges.ts",
];

const isCheckFile = (name: string): boolean => /^(?:check-|Check[A-Z]).*\.ts$/.test(name);

type PlantedViolation = {
    readonly edits: Readonly<Record<string, FileEdit>>;
    // What the rule's failure must name.
    readonly named: string;
};

const withoutPushDenials = editJson((settings) => {
    const permissions = settings["permissions"];
    if (typeof permissions !== "object" || permissions === null) {
        throw new Error("the settings have no permissions");
    }
    const deny: unknown = Object.getOwnPropertyDescriptor(permissions, "deny")?.value;
    if (!Array.isArray(deny)) {
        throw new Error("the settings have no deny list");
    }
    Object.assign(permissions, {
        deny: deny.filter((rule) => !(typeof rule === "string" && /\bpush\b/.test(rule))),
    });
});

const PLANTED_VIOLATIONS: Readonly<Record<RepositoryRuleName, PlantedViolation>> = {
    [RepositoryRuleName.Licences]: {
        edits: { "docs/plan-language/planted-unlisted.schema.json": '{ "type": "object" }\n' },
        named: "planted-unlisted.schema.json",
    },
    [RepositoryRuleName.Layout]: {
        edits: { "planted-loose-script.ts": "export const loose = 1;\n" },
        named: "planted-loose-script.ts",
    },
    [RepositoryRuleName.Imports]: {
        edits: {
            "packages/engine/src/planted-outside-import.ts":
                "import pad from 'left-pad';\nexport const padded = pad;\n",
        },
        named: "planted-outside-import.ts",
    },
    [RepositoryRuleName.RuntimeImports]: {
        edits: {
            "packages/report/src/planted-browser-library.ts":
                "import { chromium } from 'playwright-core';\nexport const browser = chromium;\n",
        },
        named: "planted-browser-library.ts",
    },
    [RepositoryRuleName.BrandedCasts]: {
        edits: {
            "packages/report/src/planted-cast.ts":
                "import type { SafeText } from '@revisum/contracts';\nexport const heading = 'Results' as SafeText;\n",
        },
        named: "planted-cast.ts",
    },
    [RepositoryRuleName.PersonGates]: {
        edits: {
            "packages/report/src/planted-person-gate.ts":
                "export const isPerson = (actorType: string): boolean => actorType === 'person-verified';\n",
        },
        named: "planted-person-gate.ts",
    },
    [RepositoryRuleName.ApprovalStrength]: {
        edits: {
            "packages/report/src/planted-strength-gate.ts":
                "import type { VerifiedApproval } from '@revisum/contracts';\nexport const hasApproval = (approval: VerifiedApproval): boolean => approval !== undefined;\n",
        },
        named: "planted-strength-gate.ts",
    },
    [RepositoryRuleName.ErrorAnchors]: {
        edits: {
            "docs/errors.md": (text) =>
                text
                    .split("\n")
                    .filter((line) => !/^##\s+not-append-only\s*$/.test(line))
                    .join("\n"),
        },
        named: "not-append-only",
    },
    [RepositoryRuleName.SecretReveal]: {
        edits: {
            "packages/cli/src/planted-secret-peek.ts":
                "import { reveal } from '@revisum/contracts';\nexport const peek = reveal;\n",
        },
        named: "planted-secret-peek.ts",
    },
    [RepositoryRuleName.PlanSchema]: {
        edits: { "docs/plan-language/plan.schema.json": (text) => `${text}\n` },
        named: "plan.schema.json",
    },
    [RepositoryRuleName.DependencyReviews]: {
        edits: { "tools/dependency-reviews.ts": (text) => text.replace("4.14.0", "4.13.0") },
        named: "axe-core",
    },
    [RepositoryRuleName.DenyRules]: {
        edits: { ".claude/settings.json": withoutPushDenials },
        named: "settings.json",
    },
    [RepositoryRuleName.Glossary]: {
        edits: {
            "docs/glossary.md": (text) =>
                text.replace(
                    "| Engine | `engine` package |",
                    "| Planted term | `plantedMissingExport` | `engine`, exists | Names nothing |\n| Engine | `engine` package |",
                ),
        },
        named: "plantedMissingExport",
    },
};

const everyPlantedEdit: Readonly<Record<string, FileEdit>> = Object.fromEntries(
    Object.values(PLANTED_VIOLATIONS).flatMap((planted) => Object.entries(planted.edits)),
);

describe("Using the repository rules tool", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given the repository as it stands", () => {
        const registeredFiles = Object.values(REPOSITORY_RULES).map((rule) => rule.file);

        describe("when the lint script is read", () => {
            test("then it should be what npm run lint runs, with no rule left out", () => {
                const manifest = JSON.parse(
                    readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
                ) as {
                    readonly scripts: Readonly<Record<string, string>>;
                };
                assert.equal(manifest.scripts["lint"], "node tools/RunRepositoryRules.ts");
            });
        });

        describe("when the tools folder is read", () => {
            test("then it should have every check file in tools as a rule, or named as not being one", () => {
                const checkFiles = readdirSync(TOOLS_FOLDER).filter(isCheckFile).toSorted();
                assert.deepEqual(
                    checkFiles,
                    [...registeredFiles, ...CHECKS_THAT_ARE_NOT_REPOSITORY_RULES].toSorted(),
                );
            });

            test("then it should name a file that exists for every rule", () => {
                assert.deepEqual(
                    registeredFiles.filter((file) => !existsSync(join(TOOLS_FOLDER, file))),
                    [],
                );
            });
        });
    });

    describe("given a copy with one violation of every rule", () => {
        describe("when npm run lint runs", () => {
            test(
                "then it should report every rule as failed, in the fixed order",
                { timeout: TIMEOUT },
                () => {
                    const outcome = lintWithEdits(scratch, everyPlantedEdit);
                    assert.equal(outcome.passed, false, "the lint passed");
                    const summary = outcome.failureOutput
                        .split("\n")
                        .find((line) => line.startsWith("repository rules failed: "));
                    assert.equal(
                        summary,
                        `repository rules failed: ${RULE_NAMES.join(", ")}`,
                        outcome.failureOutput,
                    );
                },
            );

            test("then it should say what is wrong under each rule", { timeout: TIMEOUT }, () => {
                const { failureOutput } = lintWithEdits(scratch, everyPlantedEdit);
                const unreported = RULE_NAMES.filter(
                    (name) =>
                        !failureOutput
                            .split("\n")
                            .some(
                                (line) =>
                                    line.startsWith(`${REPOSITORY_RULES[name].label}: `) &&
                                    line.includes(PLANTED_VIOLATIONS[name].named),
                            ),
                );
                assert.deepEqual(unreported, [], failureOutput);
            });
        });
    });

    for (const name of RULE_NAMES) {
        describe(`given a copy with one violation of the ${name} rule`, () => {
            describe(`when --only ${name} runs`, () => {
                test("then it should fail, naming the violation", { timeout: TIMEOUT }, () => {
                    const { edits, named } = PLANTED_VIOLATIONS[name];
                    const outcome = lintWithEdits(scratch, edits, { rule: name });
                    assert.equal(outcome.passed, false, "the rule passed");
                    assert.ok(
                        outcome.failureOutput.includes(`${REPOSITORY_RULES[name].label}: `),
                        outcome.failureOutput,
                    );
                    assert.ok(outcome.failureOutput.includes(named), outcome.failureOutput);
                    assert.ok(
                        outcome.failureOutput.includes(`repository rules failed: ${name}\n`),
                        outcome.failureOutput,
                    );
                });
            });
        });
    }

    describe("given a list of rules", () => {
        describe("when it names them out of order", () => {
            test("then it should run just those, in the fixed order", { timeout: TIMEOUT }, () => {
                const run = runTool(
                    join(scratch.root(), "tools", "RunRepositoryRules.ts"),
                    ["--only", "glossary,layout"],
                    { cwd: scratch.root() },
                );
                assert.equal(run.passed, true, describeRun(run));
                assert.deepEqual(run.output.trim().split(/\r?\n/), [
                    "layout check passed",
                    "glossary check passed",
                ]);
            });
        });

        describe("when it names a rule that does not exist", () => {
            test("then it should run nothing and fail, naming the rule and the rules there are", () => {
                const run = runTool("RunRepositoryRules.ts", ["--only", "layout,planted-rule"], {
                    cwd: REPOSITORY_ROOT,
                });
                assert.equal(run.status, 2, describeRun(run));
                assert.ok(run.output.includes("planted-rule"), describeRun(run));
                assert.ok(run.output.includes(RepositoryRuleName.Glossary), describeRun(run));
                assert.ok(!run.output.includes("layout check"), describeRun(run));
            });
        });
    });

    describe("given a check file that cannot load", () => {
        describe("when its rule and another run", () => {
            test(
                "then it should fail that rule and still run the other",
                { timeout: TIMEOUT },
                () => {
                    const run = withEdits(
                        scratch.root(),
                        { "tools/check-layout.ts": "export const = ;\n" },
                        () =>
                            runTool(
                                join(scratch.root(), "tools", "RunRepositoryRules.ts"),
                                ["--only", "layout,glossary"],
                                { cwd: scratch.root() },
                            ),
                    );
                    assert.equal(run.status, 1, describeRun(run));
                    assert.ok(
                        run.output.includes("layout check: could not run: "),
                        describeRun(run),
                    );
                    assert.ok(run.output.includes("glossary check passed"), describeRun(run));
                    assert.ok(
                        run.output.includes("repository rules failed: layout\n"),
                        describeRun(run),
                    );
                },
            );
        });
    });
});
