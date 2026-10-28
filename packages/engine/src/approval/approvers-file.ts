// Decoders for the files the approval routes read from the protected branch: approvers.json, the
// coding agent's deny-rules file and holdouts.json. Each is outside input until decoded here.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import type { AgentLockdown, AgentLockdownAction } from '@revisum/contracts';
import { INVALID, allValid, readList, readOneOf, readRecord, type Issues, type Parsed } from '../plan/plan-decoders.ts';

export type SigningKey = { readonly keyId: string; readonly publicKey: string };
export type ApproversFile = { readonly agentLockdown: AgentLockdown | null; readonly signingKeys: readonly SigningKey[] };

const LOCKDOWN_ACTIONS: readonly AgentLockdownAction[] = ['commit', 'push', 'merge', 'approve-pull-request'];
// The denials the lock-down route needs. A commit approves nothing, so denying it is optional.
export const REQUIRED_DENIED_ACTIONS: readonly AgentLockdownAction[] = ['push', 'merge', 'approve-pull-request'];

function readString(input: unknown, path: string, issues: Issues): Parsed<string> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input.length === 0) { issues.push({ code: 'empty', path }); return INVALID; }
  return input;
}

function readLockdown(input: unknown, issues: Issues): Parsed<AgentLockdown | null> {
  if (input === undefined) return null;
  const path = '$.agentLockdown';
  const fields = readRecord(input, path, issues, ['maintainer', 'agentDenyRulesPath', 'deniedActions', 'agentHasGithubCredentials']);
  if (fields === INVALID) return INVALID;
  const rawActions = readList(fields['deniedActions'], `${path}.deniedActions`, issues, LOCKDOWN_ACTIONS.length, 0);
  const deniedActions = (rawActions === INVALID ? [] : rawActions)
    .map((action, index) => readOneOf(action, `${path}.deniedActions[${index}]`, issues, LOCKDOWN_ACTIONS));
  const maintainer = readString(fields['maintainer'], `${path}.maintainer`, issues);
  const agentDenyRulesPath = readString(fields['agentDenyRulesPath'], `${path}.agentDenyRulesPath`, issues);
  const credentials = fields['agentHasGithubCredentials'];
  if (typeof credentials !== 'boolean') issues.push({ code: 'wrong_type', path: `${path}.agentHasGithubCredentials` });
  if (rawActions === INVALID || maintainer === INVALID || agentDenyRulesPath === INVALID || typeof credentials !== 'boolean'
    || !allValid(deniedActions)) return INVALID;
  return { maintainer, agentDenyRulesPath, deniedActions, agentHasGithubCredentials: credentials };
}

function readSigningKeys(input: unknown, issues: Issues): Parsed<readonly SigningKey[]> {
  if (input === undefined) return [];
  const raw = readList(input, '$.signingKeys', issues, 64, 0);
  if (raw === INVALID) return INVALID;
  const keys = raw.map((entry, index): Parsed<SigningKey> => {
    const path = `$.signingKeys[${index}]`;
    const fields = readRecord(entry, path, issues, ['keyId', 'publicKey']);
    if (fields === INVALID) return INVALID;
    const keyId = readString(fields['keyId'], `${path}.keyId`, issues);
    const publicKey = readString(fields['publicKey'], `${path}.publicKey`, issues);
    return keyId === INVALID || publicKey === INVALID ? INVALID : { keyId, publicKey };
  });
  return allValid(keys) ? keys : INVALID;
}

// approvers.json: the agent lock-down declaration and, for the optional signed route, its keys.
export function parseApproversFile(input: unknown): ApproversFile | null {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['agentLockdown', 'signingKeys'], []);
  if (fields === INVALID) return null;
  const agentLockdown = readLockdown(fields['agentLockdown'], issues);
  const signingKeys = readSigningKeys(fields['signingKeys'], issues);
  return agentLockdown === INVALID || signingKeys === INVALID ? null : { agentLockdown, signingKeys };
}

// ---- The coding agent's deny rules ----------------------------------------------------------------

// A rule such as "Bash(git push *)" or "PowerShell(gh pr review *)", in Claude Code's settings.json.
const SHELL_RULE = /^(?:Bash|PowerShell)\((.*)\)$/s;

// Commands an agent would run to push, merge or approve a pull request. A rule denies an action
// when its pattern matches one of the action's commands. Merge counts as denied when either
// git merge or gh pr merge is, as the spec's build notes settle.
const ACTION_COMMANDS: Readonly<Record<'push' | 'merge' | 'approve-pull-request', readonly string[]>> = {
  'push': ['git push origin main'],
  'merge': ['git merge feature', 'gh pr merge 1'],
  'approve-pull-request': ['gh pr review 1 --approve'],
};

// A rule's command pattern as a regular expression: "*" matches anything, and the older ":*"
// suffix means "this prefix followed by anything".
function commandExpression(pattern: string): RegExp {
  const prefixed = pattern.endsWith(':*') ? `${pattern.slice(0, -2)}*` : pattern;
  const escaped = prefixed.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

// The deny rules from a Claude Code settings.json (`permissions.deny`), or null when the file
// has none. Other settings are ignored; entries that are not text are skipped.
export function parseDenyRules(input: unknown): readonly string[] | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const permissions: unknown = Object.getOwnPropertyDescriptor(input, 'permissions')?.value;
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) return null;
  const deny: unknown = Object.getOwnPropertyDescriptor(permissions, 'deny')?.value;
  if (!Array.isArray(deny)) return null;
  return deny.filter((rule): rule is string => typeof rule === 'string');
}

// True when the rules deny push, merge and pull-request approval in Bash or PowerShell.
export function deniesRequiredActions(rules: readonly string[]): boolean {
  const patterns = rules.flatMap((rule) => {
    const command = SHELL_RULE.exec(rule.trim())?.[1];
    return command === undefined ? [] : [commandExpression(command.trim())];
  });
  return Object.values(ACTION_COMMANDS).every((commands) =>
    commands.some((command) => patterns.some((pattern) => pattern.test(command))));
}

// ---- holdouts.json ----------------------------------------------------------------------------------

// The holdout-plan hashes holdouts.json lists, across every change class; empty when unreadable.
export function holdoutPlanHashes(input: unknown): readonly string[] {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['changeClasses']);
  if (fields === INVALID) return [];
  const classes = readList(fields['changeClasses'], '$.changeClasses', issues, 256, 0);
  if (classes === INVALID) return [];
  return classes.flatMap((entry, index) => {
    const changeClass = readRecord(entry, `$.changeClasses[${index}]`, issues, ['changeClassId', 'planHashes']);
    if (changeClass === INVALID) return [];
    const hashes = changeClass['planHashes'];
    return Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === 'string') : [];
  });
}
