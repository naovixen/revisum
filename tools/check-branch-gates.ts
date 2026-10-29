// Nothing on the default branch is gated behind a second person. Reads GitHub's JSON for a
// branch's rules (GET /repos/{owner}/{repo}/rules/branches/{branch}) and, optionally, its classic
// protection (GET /repos/{owner}/{repo}/branches/{branch}/protection), and fails when any of them:
//   - requires an approving review (a count of 1 or more), a code-owner review or approval of the
//     last push: each needs an account other than the founder's;
//   - requires a status check that .github/workflows/ci.yml does not produce, which no merge
//     could ever satisfy.
// With --require-checks it also fails unless both `ci` and `tests-apart` are required, which is
// how branch protection makes a mixed change unmergeable. So a merge by the founder after a green
// run meets every required gate.
//   node tools/check-branch-gates.ts --rules <file> [--protection <file>] [--require-checks]
// The live rules are read in CI once the repository goes public; until then, recorded JSON.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORKFLOW_PATH = '.github/workflows/ci.yml';
// The checks a merge must wait for: every gate, and the tests-apart check.
export const REQUIRED_CHECKS: readonly string[] = ['ci', 'tests-apart'];

export type BranchGates = {
  // Why a second person would be needed, one line each.
  readonly secondPersonGates: readonly string[];
  readonly requiredChecks: readonly string[];
};

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

// The review settings shared by a ruleset's pull_request rule and classic protection's
// required_pull_request_reviews, under their two spellings.
function reviewGates(settings: unknown, source: string): string[] {
  const gates: string[] = [];
  const count = fieldOf(settings, 'required_approving_review_count');
  if (typeof count === 'number' && count >= 1) gates.push(`${source} requires ${count} approving review(s)`);
  if (fieldOf(settings, 'require_code_owner_review') === true || fieldOf(settings, 'require_code_owner_reviews') === true) {
    gates.push(`${source} requires a code-owner review`);
  }
  if (fieldOf(settings, 'require_last_push_approval') === true) gates.push(`${source} requires approval of the last push`);
  return gates;
}

const contextsOf = (checks: unknown): string[] =>
  listOf(checks).flatMap((check) => {
    const context = fieldOf(check, 'context');
    return typeof context === 'string' ? [context] : [];
  });

// The rules that apply to a branch: a JSON list of rules, each with a `type` and `parameters`.
export function readRules(input: unknown): BranchGates {
  if (!Array.isArray(input)) throw new Error('the rules are not a JSON list');
  const secondPersonGates: string[] = [];
  const requiredChecks: string[] = [];
  for (const rule of input) {
    const type = fieldOf(rule, 'type');
    const parameters = fieldOf(rule, 'parameters');
    if (type === 'pull_request') secondPersonGates.push(...reviewGates(parameters, 'a ruleset\'s pull_request rule'));
    if (type === 'required_status_checks') requiredChecks.push(...contextsOf(fieldOf(parameters, 'required_status_checks')));
  }
  return { secondPersonGates, requiredChecks };
}

// A branch's classic protection: a JSON object, empty when the branch has none.
export function readProtection(input: unknown): BranchGates {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('the protection is not a JSON object');
  const reviews = fieldOf(input, 'required_pull_request_reviews');
  const statusChecks = fieldOf(input, 'required_status_checks');
  const contexts = listOf(fieldOf(statusChecks, 'contexts')).filter((context): context is string => typeof context === 'string');
  return {
    secondPersonGates: reviews === undefined ? [] : reviewGates(reviews, 'classic branch protection'),
    requiredChecks: [...new Set([...contexts, ...contextsOf(fieldOf(statusChecks, 'checks'))])],
  };
}

// The check names a workflow produces: each job's `name`, or its id when it has none.
export function workflowChecks(workflow: string): string[] {
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const checks: string[] = [];
  let jobId: string | undefined;
  let jobName: string | undefined;
  const finishJob = (): void => { if (jobId !== undefined) checks.push(jobName ?? jobId); };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job !== null) {
      finishJob();
      jobId = job[1];
      jobName = undefined;
      continue;
    }
    const name = /^ {4}name:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (name !== null && jobId !== undefined) jobName = name[1];
  }
  finishJob();
  return checks;
}

export function checkBranchGates(gates: readonly BranchGates[], producedChecks: readonly string[], requireChecks: boolean): string[] {
  const problems = gates.flatMap((gate) => gate.secondPersonGates.map((reason) => `${reason}, which needs a second person`));
  const required = new Set(gates.flatMap((gate) => gate.requiredChecks));
  for (const check of required) {
    if (!producedChecks.includes(check)) problems.push(`a required status check "${check}" is not produced by ${WORKFLOW_PATH}, so no merge could satisfy it`);
  }
  if (requireChecks) {
    for (const check of REQUIRED_CHECKS) {
      if (!required.has(check)) problems.push(`the status check "${check}" is not required`);
    }
  }
  return problems;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(words: readonly string[]): number {
  const valueAfter = (flag: string): string | undefined => {
    const index = words.indexOf(flag);
    return index === -1 ? undefined : words[index + 1];
  };
  const rulesPath = valueAfter('--rules');
  if (rulesPath === undefined) {
    console.error('usage: node tools/check-branch-gates.ts --rules <file> [--protection <file>] [--require-checks]');
    return 2;
  }
  const protectionPath = valueAfter('--protection');
  let problems: string[];
  try {
    const gates = [readRules(readJson(rulesPath))];
    if (protectionPath !== undefined) gates.push(readProtection(readJson(protectionPath)));
    const produced = workflowChecks(readFileSync(join(process.cwd(), WORKFLOW_PATH), 'utf8'));
    problems = checkBranchGates(gates, produced, words.includes('--require-checks'));
  } catch (error) {
    problems = [`cannot read the branch gates: ${error instanceof Error ? error.message : String(error)}`];
  }
  for (const problem of problems) console.error(`branch gates: ${problem}`);
  console.log(problems.length === 0 ? 'branch gates passed' : `branch gates failed: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
