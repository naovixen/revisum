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

// The command family behind each action that would let the agent approve its own work. A family is
// the command alone and the command with any arguments: every remote, branch and flag of git push;
// every pull request and flag of gh pr merge; every gh pr review, since --approve, -a and the order
// of arguments vary. Denying one example command, such as "git push origin main", leaves the rest
// of the family open, so it does not count. A local git merge lands nothing without a push, so
// merge is denied by denying gh pr merge, which merges on GitHub.
const ACTION_FAMILIES: Readonly<Record<'push' | 'merge' | 'approve-pull-request', string>> = {
  'push': 'git push',
  'merge': 'gh pr merge',
  'approve-pull-request': 'gh pr review',
};

// A rule's command pattern, with the older ":*" suffix ("this prefix followed by anything")
// written as a plain trailing "*".
const asGlob = (pattern: string): string => (pattern.endsWith(':*') ? `${pattern.slice(0, -2)}*` : pattern);

// A glob as a regular expression over a whole command: "*" matches anything.
function globExpression(glob: string): RegExp {
  const escaped = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

// True when the pattern matches the family's command with no arguments. As Claude Code reads its
// rules, a trailing " *" also matches the command with nothing after it.
function deniesBareCommand(glob: string, family: string): boolean {
  return globExpression(glob).test(family) || (glob.endsWith(' *') && globExpression(glob.slice(0, -2)).test(family));
}

// True when the pattern matches the family's command followed by any arguments at all: it ends in
// "*" and what comes before that star matches the start of "<family> ", so the star swallows every
// argument list whatever it holds. "git push *" and "git *" qualify; "git push origin *" does not.
function deniesEveryArgument(glob: string, family: string): boolean {
  if (!glob.endsWith('*')) return false;
  const head = globExpression(glob.slice(0, -1));
  const withSpace = `${family} `;
  for (let length = 0; length <= withSpace.length; length++) {
    if (head.test(withSpace.slice(0, length))) return true;
  }
  return false;
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

// True when the rules deny the whole of each family, push, merge and pull-request approval, in
// Bash or PowerShell: its command alone and with any arguments, by one rule or two.
export function deniesRequiredActions(rules: readonly string[]): boolean {
  const globs = rules.flatMap((rule) => {
    const command = SHELL_RULE.exec(rule.trim())?.[1];
    return command === undefined ? [] : [asGlob(command.trim())];
  });
  return Object.values(ACTION_FAMILIES).every((family) =>
    globs.some((glob) => deniesBareCommand(glob, family)) && globs.some((glob) => deniesEveryArgument(glob, family)));
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
