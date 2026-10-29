// The coding agent's deny rules (.claude/settings.json) lock it out of everything that would let
// it approve its own work: push, merge and pull-request approval, as the engine's
// deniesRequiredActions requires, and this repository's history denials: amend, skipping hooks,
// rebase, tag and hard reset. The agent may still make ordinary commits. The lint reads the file
// from the working tree; each test removes one denial, in every shell, from a throw-away copy of
// the repository and expects the lint to fail naming it.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, editJson, lintWithEdits } from './scratch-edits.ts';

const SETTINGS_PATH = '.claude/settings.json';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

// The settings with every deny rule that `matches` removed.
const withoutDenials = (matches: (rule: string) => boolean) => editJson((settings) => {
  const permissions = settings['permissions'];
  if (typeof permissions !== 'object' || permissions === null) throw new Error(`${SETTINGS_PATH} has no permissions`);
  const deny: unknown = Object.getOwnPropertyDescriptor(permissions, 'deny')?.value;
  if (!Array.isArray(deny)) throw new Error(`${SETTINGS_PATH} has no deny list`);
  const kept = deny.filter((rule) => !(typeof rule === 'string' && matches(rule)));
  if (kept.length === deny.length) throw new Error(`no deny rule in ${SETTINGS_PATH} matched`);
  Object.assign(permissions, { deny: kept });
});

// Each required denial: what to remove, and what the failure must mention.
const REQUIRED_DENIALS: readonly { readonly action: string; readonly matches: (rule: string) => boolean; readonly named: RegExp }[] = [
  { action: 'push', matches: (rule) => /\bpush\b/.test(rule), named: /push/i },
  { action: 'merge (git merge and gh pr merge)', matches: (rule) => /\bmerge\b/.test(rule), named: /merge/i },
  { action: 'pull-request approval', matches: (rule) => rule.includes('gh pr review'), named: /approv|review/i },
  { action: 'amending a commit', matches: (rule) => rule.includes('--amend'), named: /amend/i },
  { action: 'skipping hooks', matches: (rule) => rule.includes('--no-verify'), named: /no-verify|hook/i },
  { action: 'rebase', matches: (rule) => /\brebase\b/.test(rule), named: /rebase/i },
  { action: 'tag', matches: (rule) => /\bgit tag\b/.test(rule), named: /tag/i },
  { action: 'hard reset', matches: (rule) => rule.includes('reset --hard'), named: /reset/i },
];

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-19', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

for (const { action, matches, named } of REQUIRED_DENIALS) {
  test(`the lint fails when the deny rules no longer deny ${action}`, { criterion: 'AC-SPEC-00-19', timeout: TIMEOUT }, () => {
    const outcome = lintWithEdits(scratch, { [SETTINGS_PATH]: withoutDenials(matches) });
    assertLintFails(outcome, ['settings.json']);
    if (!named.test(outcome.failureOutput)) {
      throw new Error(`the lint failed, but did not name the missing denial (${action}):\n${outcome.failureOutput}`);
    }
  });
}

test('counter-example: removing a denial the lock-down does not need passes', { criterion: 'AC-SPEC-00-19', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, { [SETTINGS_PATH]: withoutDenials((rule) => rule.includes('npm publish')) }));
});
