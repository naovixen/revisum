// The coding agent's deny rules (.claude/settings.json) must lock it out of everything that would
// let it approve its own work, in Bash and in PowerShell alike:
//   - push, merge and pull-request approval, as the engine's deniesRequiredActions requires for the
//     agent lock-down approval route;
//   - this repository's history denials: amending a commit, skipping hooks, rebase, tag and hard
//     reset. Ordinary commits stay allowed: the agent commits, the founder pushes.
// The file is read from the working tree; on a push to main that is the default branch's copy.
// Runs in `npm run lint`. See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEngineFunction } from './engine-loader.ts';
import { reportProblems } from './workspace-packages.ts';

export const SETTINGS_PATH = '.claude/settings.json';
const SHELLS = ['Bash', 'PowerShell'] as const;

// Each history denial, and commands it must stop: any of them matching a deny rule is enough.
const HISTORY_DENIALS: readonly { readonly action: string; readonly commands: readonly string[] }[] = [
  { action: 'amending a commit (git commit --amend)', commands: ['git commit --amend', 'git commit --amend --no-edit'] },
  { action: 'skipping hooks (git commit --no-verify)', commands: ['git commit --no-verify -m change'] },
  { action: 'rebase (git rebase)', commands: ['git rebase main'] },
  { action: 'tag (git tag)', commands: ['git tag release'] },
  { action: 'hard reset (git reset --hard)', commands: ['git reset --hard HEAD'] },
];

// A rule's command pattern as a regular expression, as Claude Code matches it: "*" matches
// anything, and the older ":*" suffix means "this prefix followed by anything".
function commandPattern(pattern: string): RegExp {
  const prefixed = pattern.endsWith(':*') ? `${pattern.slice(0, -2)}*` : pattern;
  const escaped = prefixed.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

// The command patterns of one shell's rules, such as "git push *" from "Bash(git push *)".
function shellPatterns(rules: readonly string[], shell: string): RegExp[] {
  return rules.flatMap((rule) => {
    const match = new RegExp(`^${shell}\\((.*)\\)$`, 's').exec(rule.trim());
    return match?.[1] === undefined ? [] : [commandPattern(match[1].trim())];
  });
}

export async function checkDenyRules(root: string): Promise<string[]> {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(root, SETTINGS_PATH), 'utf8'));
  } catch (error) {
    return [`${SETTINGS_PATH} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  const parseDenyRules = await loadEngineFunction(root, 'parseDenyRules');
  const deniesRequiredActions = await loadEngineFunction(root, 'deniesRequiredActions');
  const parsed = parseDenyRules(settings);
  if (!Array.isArray(parsed)) return [`${SETTINGS_PATH} has no permissions.deny list`];
  const rules = parsed.filter((rule): rule is string => typeof rule === 'string');

  const problems: string[] = [];
  for (const shell of SHELLS) {
    const prefix = `${shell}(`;
    const shellRules = rules.filter((rule) => rule.trim().startsWith(prefix));
    if (deniesRequiredActions(shellRules) !== true) {
      problems.push(`${SETTINGS_PATH} does not deny push, merge (git merge or gh pr merge) and pull-request approval (gh pr review) in ${shell}`);
    }
    const patterns = shellPatterns(rules, shell);
    for (const { action, commands } of HISTORY_DENIALS) {
      const denied = commands.some((command) => patterns.some((pattern) => pattern.test(command)));
      if (!denied) problems.push(`${SETTINGS_PATH} does not deny ${action} in ${shell}`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('deny rule check', await checkDenyRules(process.cwd()));
