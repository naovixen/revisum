// No gate, metric or level may depend on an approval being verified: verified and declared both
// pass, and strength only selects a label. Each test plants one file in a throw-away copy of the
// repository and runs the repository's lint commands over it:
//   - a function that takes a VerifiedApproval parameter fails the lint;
//   - a check that compares strength with 'verified' to decide a result fails the lint, and so does
//     one that compares it with an ApprovalStrength constant, or tests it with startsWith or includes;
//   - choosing a label by strength passes, so the lint fails for the planted reason only.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const ONLY_THE_RULE = { rule: RepositoryRuleName.ApprovalStrength };

let scratch: ScratchRepository;
before(() => {
    scratch = copyRepository();
});
after(() => {
    scratch.dispose();
});

const TIMEOUT = 300_000;

function assertLintFailsOn(relativePath: string, source: string): void {
    const outcome = scratch.lintWith(relativePath, source, ONLY_THE_RULE);
    assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
    const fileName = relativePath.split("/").at(-1) ?? relativePath;
    assert.ok(
        outcome.failureOutput.includes(fileName),
        `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`,
    );
}

function assertLintPassesWith(relativePath: string, source: string): void {
    const outcome = scratch.lintWith(relativePath, source);
    assert.equal(
        outcome.passed,
        true,
        `the lint rejected ${relativePath}:\n${outcome.failureOutput}`,
    );
}

test("the unchanged copy of the repository passes every lint command", { timeout: TIMEOUT }, () => {
    const outcome = scratch.lint();
    assert.equal(outcome.passed, true, outcome.failureOutput);
});

// ---- Taking VerifiedApproval --------------------------------------------------------------------

test(
    "the lint fails on an engine gate that takes a VerifiedApproval parameter",
    { timeout: TIMEOUT },
    () => {
        assertLintFailsOn(
            "packages/engine/src/plan/planted-merge-gate.ts",
            [
                "import type { VerifiedApproval } from '@revisum/contracts';",
                "// A merge gate only a verified approval can open, so the owner's declared approval would be shut out.",
                "export const opensMergeGate = (approval: VerifiedApproval): boolean => approval.subject.hash.length > 0;",
                "",
            ].join("\n"),
        );
    },
);

test(
    "the lint fails on a level function in another package that takes a VerifiedApproval parameter",
    { timeout: TIMEOUT },
    () => {
        assertLintFailsOn(
            "packages/report/src/planted-level.ts",
            [
                "import type { VerifiedApproval } from '@revisum/contracts';",
                "export function reachesLevelFour(approvals: readonly VerifiedApproval[]): boolean {",
                "  return approvals.length > 0;",
                "}",
                "",
            ].join("\n"),
        );
    },
);

// ---- Testing strength to decide a result --------------------------------------------------------

test(
    "the lint fails on a metric that counts only approvals whose strength is 'verified'",
    { timeout: TIMEOUT },
    () => {
        assertLintFailsOn(
            "packages/engine/src/planted-metric.ts",
            [
                "import type { Approval } from '@revisum/contracts';",
                "export const approvedChanges = (approvals: readonly Approval[]): number =>",
                "  approvals.filter((approval) => approval.strength === 'verified').length;",
                "",
            ].join("\n"),
        );
    },
);

test(
    "the lint fails on a reversed inequality that refuses a strength other than 'verified'",
    { timeout: TIMEOUT },
    () => {
        assertLintFailsOn(
            "packages/report/src/planted-gate.ts",
            [
                "import type { Approval } from '@revisum/contracts';",
                "export function mayMerge(approval: Approval): boolean {",
                "  if ('verified' !== approval.strength) return false;",
                "  return true;",
                "}",
                "",
            ].join("\n"),
        );
    },
);

// ---- Strength may select a label ----------------------------------------------------------------

test(
    "the lint accepts strength used only to choose the label shown beside a result",
    { timeout: TIMEOUT },
    () => {
        assertLintPassesWith(
            "packages/report/src/planted-label.ts",
            [
                "import type { Approval, ApprovalStrength } from '@revisum/contracts';",
                "const APPROVAL_LABELS: Readonly<Record<ApprovalStrength, string>> = { verified: 'verified', declared: 'declared, not verified' };",
                "export const approvalLabel = (approval: Approval): string => APPROVAL_LABELS[approval.strength];",
                "",
            ].join("\n"),
        );
    },
);

test(
    "the lint accepts a gate that takes any Approval, whatever its strength",
    { timeout: TIMEOUT },
    () => {
        assertLintPassesWith(
            "packages/engine/src/plan/planted-merge-gate.ts",
            [
                "import type { Approval } from '@revisum/contracts';",
                "export const opensMergeGate = (approval: Approval | null): boolean => approval !== null;",
                "",
            ].join("\n"),
        );
    },
);

// ---- Deciding by the constants, and by string and list methods -----------------------------------

// A function whose result depends on the strength, written as the conventions ask, with the constants.
const gateDeciding = (body: string): string =>
    [
        "import { ApprovalStrength, type Approval } from '@revisum/contracts';",
        "export function mayMerge(approval: Approval): boolean {",
        `  ${body}`,
        "}",
        "",
    ].join("\n");

const STRENGTH_DECISIONS: readonly { readonly form: string; readonly body: string }[] = [
    {
        form: "=== ApprovalStrength.Verified",
        body: "return approval.strength === ApprovalStrength.Verified;",
    },
    {
        form: "!== ApprovalStrength.Declared",
        body: "return approval.strength !== ApprovalStrength.Declared;",
    },
    {
        form: "the constant on the left of the comparison",
        body: "return ApprovalStrength.Verified === approval.strength;",
    },
    {
        form: "a local holding the strength, compared with the constant",
        body: "const level = approval.strength; return level === ApprovalStrength.Verified;",
    },
    {
        form: ".startsWith with a string",
        body: "return approval.strength.startsWith('verif');",
    },
    {
        form: ".startsWith with the constant",
        body: "return approval.strength.startsWith(ApprovalStrength.Verified);",
    },
    {
        form: ".includes on the strength",
        body: "return approval.strength.includes('verif');",
    },
    {
        form: "a list of strength strings, asked with .includes",
        body: "return ['verified'].includes(approval.strength);",
    },
    {
        form: "a list of strength constants, asked with .includes",
        body: "return [ApprovalStrength.Verified].includes(approval.strength);",
    },
];

const NOT_STRENGTH_DECISIONS: readonly { readonly form: string; readonly source: string }[] = [
    {
        form: "the constant used to build an approval's fields",
        source: [
            "import { ApprovalStrength } from '@revisum/contracts';",
            "export const verifiedFields = { strength: ApprovalStrength.Verified };",
            "",
        ].join("\n"),
    },
    {
        form: "a list holding 'verified', asked about something other than strength",
        source: [
            "export const isCheckedAccount = (account: { readonly emailState: string }): boolean =>",
            "  ['verified'].includes(account.emailState);",
            "",
        ].join("\n"),
    },
    {
        form: ".startsWith on something other than strength",
        source: [
            "export const isVerifiedName = (name: string): boolean => name.startsWith('verified');",
            "",
        ].join("\n"),
    },
];

describe("Using the approval strength check", () => {
    for (const { form, body } of STRENGTH_DECISIONS) {
        describe(`given a gate that decides by the strength with ${form}`, () => {
            describe("when the check runs", () => {
                test("then it should fail, naming the file", { timeout: TIMEOUT }, () => {
                    assertLintFailsOn(
                        "packages/engine/src/planted-constant-gate.ts",
                        gateDeciding(body),
                    );
                });
            });
        });
    }

    for (const { form, source } of NOT_STRENGTH_DECISIONS) {
        describe(`given ${form}`, () => {
            describe("when the check runs", () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    const outcome = scratch.lintWith(
                        "packages/engine/src/planted-unrelated.ts",
                        source,
                        ONLY_THE_RULE,
                    );
                    assert.equal(outcome.passed, true, outcome.failureOutput);
                });
            });
        });
    }
});
