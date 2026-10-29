// The agent lock-down route needs the coding agent denied push, merge and pull-request approval as
// whole families of commands, not one example command each. A rule set that denies only
// "git push origin main" leaves "git push", "git push --force" and every other remote and branch
// open, so it must not count as a lock-down. The repository's own deny rules, and the fixture
// repositories' rules, deny the whole families and still count.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deniesRequiredActions, parseDenyRules } from '@revisum/engine';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { assertRefused, denyRulesOf, readFixture, withRepository } from './approval-repositories.ts';

// Rules that deny each family whole.
const WHOLE_PUSH = ['Bash(git push)', 'Bash(git push *)'];
const WHOLE_MERGE = ['Bash(git merge *)', 'Bash(gh pr merge *)'];
const WHOLE_APPROVAL = ['Bash(gh pr review *)'];

// Rule sets that each leave part of at least one family open; the title says which part.
const PARTIAL_RULE_SETS: readonly { readonly title: string; readonly rules: readonly string[] }[] = [
  {
    title: 'one example command per action (git push origin main, gh pr merge 1, gh pr review 1 --approve)',
    rules: ['Bash(git push origin main)', 'Bash(gh pr merge 1)', 'Bash(gh pr review 1 --approve)'],
  },
  { title: 'push to origin main only, leaving git push, --force and other remotes open', rules: ['Bash(git push origin main)', ...WHOLE_MERGE, ...WHOLE_APPROVAL] },
  { title: 'push to origin only, leaving git push --force and other remotes open', rules: ['Bash(git push origin *)', ...WHOLE_MERGE, ...WHOLE_APPROVAL] },
  { title: 'bare git push only, leaving every push with arguments open', rules: ['Bash(git push)', ...WHOLE_MERGE, ...WHOLE_APPROVAL] },
  { title: 'merging pull request 1 only, leaving every other pull request and git merge open', rules: [...WHOLE_PUSH, 'Bash(gh pr merge 1)', ...WHOLE_APPROVAL] },
  { title: 'merging the branch "feature" only, leaving every other merge open', rules: [...WHOLE_PUSH, 'Bash(git merge feature)', ...WHOLE_APPROVAL] },
  { title: 'approving pull request 1 only, leaving every other pull request open', rules: [...WHOLE_PUSH, ...WHOLE_MERGE, 'Bash(gh pr review 1 --approve)'] },
  { title: 'reviewing pull request 1 only, with any flags', rules: [...WHOLE_PUSH, ...WHOLE_MERGE, 'Bash(gh pr review 1 *)'] },
];

for (const { title, rules } of PARTIAL_RULE_SETS) {
  test(`deny rules that cover ${title} do not deny the required actions`, { criterion: 'AC-SPEC-02-15' }, () => {
    assert.equal(deniesRequiredActions(rules), false, `these rules counted as a lock-down: ${JSON.stringify(rules)}`);
  });
}

// ---- Counter-examples: rules that deny the whole families -----------------------------------------

test('deny rules that cover each whole family deny the required actions', { criterion: 'AC-SPEC-02-14' }, () => {
  assert.equal(deniesRequiredActions([...WHOLE_PUSH, ...WHOLE_MERGE, ...WHOLE_APPROVAL]), true);
});

test("this repository's own deny rules deny the required actions", { criterion: 'AC-SPEC-02-14' }, () => {
  const rules = parseDenyRules(JSON.parse(readFileSync(join(REPOSITORY_ROOT, '.claude', 'settings.json'), 'utf8')));
  assert.notEqual(rules, null, 'the repository has no deny rules');
  assert.equal(deniesRequiredActions(rules ?? []), true);
});

for (const name of ['solo', 'team'] as const) {
  test(`the ${name} fixture repository's deny rules deny the required actions`, { criterion: 'AC-SPEC-02-14' }, () => {
    // The team rules write "git push *" without a separate bare "git push": a trailing " *" also
    // matches the command with no arguments, as in Claude Code's own rules.
    assert.equal(deniesRequiredActions(denyRulesOf(readFixture(name)).permissions.deny), true);
  });
}

// ---- Through the lock-down route ------------------------------------------------------------------

test('the lock-down route refuses with lockdown-not-declared when the deny rules name one example command per action', { criterion: 'AC-SPEC-02-15' }, async () => {
  await withRepository('solo', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.lockdownProof()), 'lockdown-not-declared');
  }, (fixture) => {
    denyRulesOf(fixture).permissions.deny = ['Bash(git push origin main)', 'Bash(gh pr merge 1)', 'Bash(gh pr review 1 --approve)'];
  });
});

test("the lock-down route approves with this repository's own deny rules in place", { criterion: 'AC-SPEC-02-14' }, async () => {
  // The counter-example: only the deny rules differ from the refusal above.
  const rules = parseDenyRules(JSON.parse(readFileSync(join(REPOSITORY_ROOT, '.claude', 'settings.json'), 'utf8'))) ?? [];
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => { denyRulesOf(fixture).permissions.deny = [...rules]; });
});
