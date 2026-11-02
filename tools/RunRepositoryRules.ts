// Runs every check in `npm run lint` in one Node process, in a fixed order, and reports all their
// failures. These are trust rules, so they stay here rather than in ESLint, where a suppression
// would be an opt-out.
// A rule's module loads only when that rule runs, so a check file that cannot load fails as its
// own rule while the others still run, and `--only` starts no more code than it needs.
//   node tools/RunRepositoryRules.ts                            every rule
//   node tools/RunRepositoryRules.ts --only imports,glossary    just those rules
//   node tools/RunRepositoryRules.ts --modules <folder>         the licence rule reads installed packages
//                                                         from this folder, not node_modules
import { resolve } from "node:path";
import { reportProblems } from "./workspace-packages.ts";

export const RepositoryRuleName = {
    Licences: "licences",
    Layout: "layout",
    Imports: "imports",
    RuntimeImports: "runtime-imports",
    BrandedCasts: "branded-casts",
    PersonGates: "person-gates",
    ApprovalStrength: "approval-strength",
    ErrorAnchors: "error-anchors",
    SecretReveal: "secret-reveal",
    PlanSchema: "plan-schema",
    DependencyReviews: "dependency-reviews",
    DenyRules: "deny-rules",
    Glossary: "glossary",
} as const;

export type RepositoryRuleName = (typeof RepositoryRuleName)[keyof typeof RepositoryRuleName];

type RuleInput = { readonly root: string; readonly modulesFolder: string | undefined };

export type RepositoryRule = {
    // What the rule's problems and result line start with.
    readonly label: string;
    // The file under tools/ that holds the check.
    readonly file: string;
    check(input: RuleInput): Promise<readonly string[]>;
};

export const REPOSITORY_RULES: Readonly<Record<RepositoryRuleName, RepositoryRule>> = {
    [RepositoryRuleName.Licences]: {
        label: "licence check",
        file: "check-licences.ts",
        check: async ({ root, modulesFolder }) =>
            (await import("./check-licences.ts")).checkLicences(root, modulesFolder),
    },
    [RepositoryRuleName.Layout]: {
        label: "layout check",
        file: "check-layout.ts",
        check: async ({ root }) => (await import("./check-layout.ts")).checkLayout(root),
    },
    [RepositoryRuleName.Imports]: {
        label: "import check",
        file: "check-imports.ts",
        check: async ({ root }) => (await import("./check-imports.ts")).checkImports(root),
    },
    [RepositoryRuleName.RuntimeImports]: {
        label: "runtime import check",
        file: "check-runtime-imports.ts",
        check: async ({ root }) =>
            (await import("./check-runtime-imports.ts")).checkRuntimeImports(root),
    },
    [RepositoryRuleName.BrandedCasts]: {
        label: "branded-type check",
        file: "check-branded-casts.ts",
        check: async ({ root }) =>
            (await import("./check-branded-casts.ts")).checkBrandedCasts(root),
    },
    [RepositoryRuleName.PersonGates]: {
        label: "person gate check",
        file: "check-person-gates.ts",
        check: async ({ root }) => (await import("./check-person-gates.ts")).checkPersonGates(root),
    },
    [RepositoryRuleName.ApprovalStrength]: {
        label: "approval strength check",
        file: "check-approval-strength.ts",
        check: async ({ root }) =>
            (await import("./check-approval-strength.ts")).checkApprovalStrength(root),
    },
    [RepositoryRuleName.ErrorAnchors]: {
        label: "error anchor check",
        file: "check-error-anchors.ts",
        check: async ({ root }) =>
            (await import("./check-error-anchors.ts")).checkErrorAnchors(root),
    },
    [RepositoryRuleName.SecretReveal]: {
        label: "secret reveal check",
        file: "check-secret-reveal.ts",
        check: async ({ root }) =>
            (await import("./check-secret-reveal.ts")).checkSecretReveal(root),
    },
    [RepositoryRuleName.PlanSchema]: {
        label: "plan schema check",
        file: "check-plan-schema.ts",
        check: async ({ root }) => (await import("./check-plan-schema.ts")).checkPlanSchema(root),
    },
    [RepositoryRuleName.DependencyReviews]: {
        label: "dependency review check",
        file: "check-dependency-reviews.ts",
        check: async ({ root }) =>
            (await import("./check-dependency-reviews.ts")).checkDependencyReviews(root),
    },
    [RepositoryRuleName.DenyRules]: {
        label: "deny rule check",
        file: "check-deny-rules.ts",
        check: async ({ root }) => (await import("./check-deny-rules.ts")).checkDenyRules(root),
    },
    [RepositoryRuleName.Glossary]: {
        label: "glossary check",
        file: "check-glossary.ts",
        check: async ({ root }) => (await import("./check-glossary.ts")).checkGlossary(root),
    },
};

const ALL_RULE_NAMES: readonly RepositoryRuleName[] = Object.values(RepositoryRuleName);

const isRepositoryRuleName = (word: string): word is RepositoryRuleName =>
    ALL_RULE_NAMES.some((name) => name === word);

export type RepositoryRuleChoice = {
    readonly rules: readonly RepositoryRuleName[];
    readonly modulesFolder: string | undefined;
};

// The chosen rules in the fixed order, however they were listed. Throws on any word it can't read,
// so a mistyped rule name can never pass by running nothing.
function readChoice(words: readonly string[]): RepositoryRuleChoice {
    let chosen: readonly RepositoryRuleName[] = ALL_RULE_NAMES;
    let modulesFolder: string | undefined;
    for (let index = 0; index < words.length; index += 2) {
        const flag = words[index];
        const value = words[index + 1];
        if (value === undefined) {
            throw new Error(`${String(flag)} needs a value`);
        }
        if (flag === "--modules") {
            modulesFolder = value;
        } else if (flag === "--only") {
            const listed = value.split(",");
            const unknown = listed.filter((word) => !isRepositoryRuleName(word));
            if (unknown.length > 0) {
                throw new Error(
                    `no rule is named ${unknown.join(", ")}; the rules are ${ALL_RULE_NAMES.join(", ")}`,
                );
            }
            chosen = ALL_RULE_NAMES.filter((name) => listed.includes(name));
        } else {
            throw new Error(
                `unknown flag ${String(flag)}; use --only <rule>[,<rule>] or --modules <folder>`,
            );
        }
    }
    return { rules: chosen, modulesFolder };
}

// Runs the chosen rules, printing each one's problems and result, and returns the exit status. A
// rule that throws has failed; the rest still run.
export async function runRepositoryRules(
    root: string,
    choice: RepositoryRuleChoice,
): Promise<number> {
    const failed: RepositoryRuleName[] = [];
    const modulesFolder =
        choice.modulesFolder === undefined ? undefined : resolve(root, choice.modulesFolder);
    for (const name of choice.rules) {
        const rule = REPOSITORY_RULES[name];
        let problems: readonly string[];
        try {
            problems = await rule.check({ root, modulesFolder });
        } catch (error) {
            problems = [
                `could not run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
            ];
        }
        if (reportProblems(rule.label, problems) !== 0) {
            failed.push(name);
        }
    }
    if (failed.length > 0) {
        console.error(`repository rules failed: ${failed.join(", ")}`);
    }
    return failed.length === 0 ? 0 : 1;
}

async function main(root: string, words: readonly string[]): Promise<number> {
    let choice: RepositoryRuleChoice;
    try {
        choice = readChoice(words);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
    return runRepositoryRules(root, choice);
}

if (import.meta.main) {
    process.exitCode = await main(process.cwd(), process.argv.slice(2));
}
