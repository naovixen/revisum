// The agent lock-down route needs the coding agent denied push, merge and pull-request approval as
// whole families of commands, not one example command each. A rule set that denies only
// "git push origin main" leaves "git push", "git push --force" and every other remote and branch
// open, so it must not count as a lock-down. The repository's own deny rules, and the fixture
// repositories' rules, deny the whole families and still count. An agent with both shells can use
// either, so each family has to be denied whole in Bash and in PowerShell alike.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deniesRequiredActions, parseDenyRules } from "@revisum/engine";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import {
    assertRefused,
    denyRulesOf,
    readFixture,
    withRepository,
} from "../approval/examples/MemoryApprovalStore.ts";

const inBothShells = (...commands: readonly string[]): string[] =>
    commands.flatMap((command) => [`Bash(${command})`, `PowerShell(${command})`]);
const inBashOnly = (...commands: readonly string[]): string[] =>
    commands.map((command) => `Bash(${command})`);
const inPowerShellOnly = (...commands: readonly string[]): string[] =>
    commands.map((command) => `PowerShell(${command})`);

// The commands that deny each family whole.
const PUSH_COMMANDS = ["git push", "git push *"];
const MERGE_COMMANDS = ["git merge *", "gh pr merge *"];
const APPROVAL_COMMANDS = ["gh pr review *"];

// Rules that deny each family whole, in both shells.
const WHOLE_PUSH = inBothShells(...PUSH_COMMANDS);
const WHOLE_MERGE = inBothShells(...MERGE_COMMANDS);
const WHOLE_APPROVAL = inBothShells(...APPROVAL_COMMANDS);

// Rule sets that each leave part of at least one family open; the title says which part.
const PARTIAL_RULE_SETS: readonly { readonly title: string; readonly rules: readonly string[] }[] =
    [
        {
            title: "one example command per action (git push origin main, gh pr merge 1, gh pr review 1 --approve)",
            rules: inBothShells(
                "git push origin main",
                "gh pr merge 1",
                "gh pr review 1 --approve",
            ),
        },
        {
            title: "push to origin main only, leaving git push, --force and other remotes open",
            rules: [...inBothShells("git push origin main"), ...WHOLE_MERGE, ...WHOLE_APPROVAL],
        },
        {
            title: "push to origin only, leaving git push --force and other remotes open",
            rules: [...inBothShells("git push origin *"), ...WHOLE_MERGE, ...WHOLE_APPROVAL],
        },
        {
            title: "bare git push only, leaving every push with arguments open",
            rules: [...inBothShells("git push"), ...WHOLE_MERGE, ...WHOLE_APPROVAL],
        },
        {
            title: "merging pull request 1 only, leaving every other pull request and git merge open",
            rules: [...WHOLE_PUSH, ...inBothShells("gh pr merge 1"), ...WHOLE_APPROVAL],
        },
        {
            title: 'merging the branch "feature" only, leaving every other merge open',
            rules: [...WHOLE_PUSH, ...inBothShells("git merge feature"), ...WHOLE_APPROVAL],
        },
        {
            title: "approving pull request 1 only, leaving every other pull request open",
            rules: [...WHOLE_PUSH, ...WHOLE_MERGE, ...inBothShells("gh pr review 1 --approve")],
        },
        {
            title: "reviewing pull request 1 only, with any flags",
            rules: [...WHOLE_PUSH, ...WHOLE_MERGE, ...inBothShells("gh pr review 1 *")],
        },
    ];

for (const { title, rules } of PARTIAL_RULE_SETS) {
    test(`deny rules that cover ${title} do not deny the required actions`, () => {
        assert.equal(
            deniesRequiredActions(rules),
            false,
            `these rules counted as a lock-down: ${JSON.stringify(rules)}`,
        );
    });
}

// ---- Counter-examples: rules that deny the whole families -----------------------------------------

test("deny rules that cover each whole family deny the required actions", () => {
    assert.equal(deniesRequiredActions([...WHOLE_PUSH, ...WHOLE_MERGE, ...WHOLE_APPROVAL]), true);
});

test("this repository's own deny rules deny the required actions", () => {
    const rules = parseDenyRules(
        JSON.parse(readFileSync(join(REPOSITORY_ROOT, ".claude", "settings.json"), "utf8")),
    );
    assert.notEqual(rules, null, "the repository has no deny rules");
    assert.equal(deniesRequiredActions(rules ?? []), true);
});

for (const name of ["solo", "team"] as const) {
    test(`the ${name} fixture repository's deny rules deny the required actions`, () => {
        // The team rules write "git push *" without a separate bare "git push": a trailing " *" also
        // matches the command with no arguments, as in Claude Code's own rules.
        assert.equal(deniesRequiredActions(denyRulesOf(readFixture(name)).permissions.deny), true);
    });
}

// ---- Through the lock-down route ------------------------------------------------------------------

test("the lock-down route refuses with lockdown-not-declared when the deny rules name one example command per action", async () => {
    await withRepository(
        "solo",
        async (repository) => {
            assertRefused(
                repository,
                await repository.verify(repository.subject("plan"), repository.lockdownProof()),
                "lockdown-not-declared",
            );
        },
        (fixture) => {
            denyRulesOf(fixture).permissions.deny = inBothShells(
                "git push origin main",
                "gh pr merge 1",
                "gh pr review 1 --approve",
            );
        },
    );
});

test("the lock-down route approves with this repository's own deny rules in place", async () => {
    // The counter-example: only the deny rules differ from the refusal above.
    const rules =
        parseDenyRules(
            JSON.parse(readFileSync(join(REPOSITORY_ROOT, ".claude", "settings.json"), "utf8")),
        ) ?? [];
    await withRepository(
        "solo",
        async (repository) => {
            const verified = await repository.verify(
                repository.subject("plan"),
                repository.lockdownProof(),
            );
            assert.equal(verified.ok, true, JSON.stringify(verified));
        },
        (fixture) => {
            denyRulesOf(fixture).permissions.deny = [...rules];
        },
    );
});

// ---- One shell left open --------------------------------------------------------------------------

// Rule sets that deny every family somewhere, yet leave a shell through which the agent can still
// push, merge or approve; the title says which.
const ONE_SHELL_OPEN_RULE_SETS: readonly {
    readonly title: string;
    readonly rules: readonly string[];
}[] = [
    {
        title: "every family is denied in Bash, with PowerShell open",
        rules: inBashOnly(...PUSH_COMMANDS, ...MERGE_COMMANDS, ...APPROVAL_COMMANDS),
    },
    {
        title: "every family is denied in PowerShell, with Bash open",
        rules: inPowerShellOnly(...PUSH_COMMANDS, ...MERGE_COMMANDS, ...APPROVAL_COMMANDS),
    },
    {
        title: "push is denied in Bash alone",
        rules: [...inBashOnly(...PUSH_COMMANDS), ...WHOLE_MERGE, ...WHOLE_APPROVAL],
    },
    {
        title: "merge is denied in PowerShell alone",
        rules: [...WHOLE_PUSH, ...inPowerShellOnly(...MERGE_COMMANDS), ...WHOLE_APPROVAL],
    },
    {
        title: "pull-request approval is denied in Bash alone",
        rules: [...WHOLE_PUSH, ...WHOLE_MERGE, ...inBashOnly(...APPROVAL_COMMANDS)],
    },
    {
        title: "push and merge are denied only in Bash and approval only in PowerShell",
        rules: [
            ...inBashOnly(...PUSH_COMMANDS, ...MERGE_COMMANDS),
            ...inPowerShellOnly(...APPROVAL_COMMANDS),
        ],
    },
    {
        title: "Bash denies only the bare git push and PowerShell denies every git push",
        rules: ["Bash(git push)", "PowerShell(git push *)", ...WHOLE_MERGE, ...WHOLE_APPROVAL],
    },
];

describe("Using the deny rules check", () => {
    describe("given deny rules that leave one shell open", () => {
        for (const { title, rules } of ONE_SHELL_OPEN_RULE_SETS) {
            describe(`and ${title}`, () => {
                describe("when the rules are checked for a lock-down", () => {
                    test("then it should not count them as denying the required actions", () => {
                        assert.equal(
                            deniesRequiredActions(rules),
                            false,
                            `these rules counted as a lock-down: ${JSON.stringify(rules)}`,
                        );
                    });
                });
            });
        }
    });
});
