// The commit-trailer grammar this project's own metrics are read from. Keys are exact, one value
// per line, in Git's trailer block (the last paragraph of the message, when every line of it is a
// "Key: value" trailer):
//   Agent: <tool>/<semantic version>   at most once; the tool is lower case, such as claude-code
//   Spec: SPEC-nn                      once per spec the commit implements; a file in docs/specs/
//   Criteria: <id>[, <id>]             criterion ids, each defined in docs/specs/
// A message is malformed when a value breaks its grammar or names nothing, when a key is a near
// miss of one of these ("agent:", "Specs:", "Criterion:"), or when a Co-Authored-By trailer names
// Claude but there is no Agent trailer. Other trailers are ignored.
// A malformed commit cannot be amended, so the main session checks each message before
// committing:
//   node tools/check-commit-trailers.ts --message <file>
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readFileSync } from 'node:fs';
import { readSpecCriteria } from './spec-criteria.ts';

export type CommitTrailers = {
  readonly agent: string | null;
  readonly specs: readonly string[];
  readonly criteria: readonly string[];
};

export type TrailerReading = {
  readonly trailers: CommitTrailers;
  // Why the message is malformed; empty when it is well formed.
  readonly problems: readonly string[];
};

// What the trailers may name: spec numbers with a file in docs/specs/, and defined criterion ids.
export type TrailerTargets = {
  readonly specNumbers: ReadonlySet<string>;
  readonly criteria: ReadonlySet<string>;
};

const TRAILER_LINE = /^([A-Za-z][\w-]*):\s?(.*)$/;
const AGENT_VALUE = /^([a-z][a-z0-9-]*)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const SPEC_VALUE = /^SPEC-(\d{2})$/;
const CRITERIA_VALUE = /^AC-SPEC-\d{2}-\d{2}(?:, AC-SPEC-\d{2}-\d{2})*$/;
// Keys that are almost one of ours: a wrong case or a singular for a plural, or the reverse.
const NEAR_MISSES: Readonly<Record<string, string>> = {
  agent: 'Agent', agents: 'Agent',
  spec: 'Spec', specs: 'Spec', specification: 'Spec', specifications: 'Spec',
  criteria: 'Criteria', criterion: 'Criteria', criterions: 'Criteria',
};

export function readTargets(root: string): TrailerTargets {
  const specs = readSpecCriteria(root);
  return { specNumbers: specs.specNumbers, criteria: specs.all };
}

// The trailer block's "Key: value" pairs, or none when the message has no trailer block.
function trailerBlock(message: string): readonly { readonly key: string; readonly value: string }[] {
  const paragraphs = message.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== '');
  // The subject is never a trailer block, even when it looks like one.
  if (paragraphs.length < 2) return [];
  const lines = (paragraphs.at(-1) ?? '').split('\n');
  const pairs = lines.map((line) => TRAILER_LINE.exec(line));
  if (pairs.some((pair) => pair === null)) return [];
  return pairs.flatMap((pair) => (pair === null ? [] : [{ key: pair[1] ?? '', value: (pair[2] ?? '').trim() }]));
}

export function readCommitTrailers(message: string, targets: TrailerTargets): TrailerReading {
  const problems: string[] = [];
  const agents: string[] = [];
  const specs: string[] = [];
  const criteria: string[] = [];
  let claudeCoAuthor = false;

  for (const { key, value } of trailerBlock(message)) {
    if (key === 'Agent') {
      agents.push(value);
      if (!AGENT_VALUE.test(value)) problems.push(`Agent: "${value}" is not <lower-case tool>/<semantic version>, such as claude-code/2.1.312`);
    } else if (key === 'Spec') {
      const specNumber = SPEC_VALUE.exec(value)?.[1];
      if (specNumber === undefined) problems.push(`Spec: "${value}" is not of the form SPEC-nn`);
      else if (!targets.specNumbers.has(specNumber)) problems.push(`Spec: ${value} has no file in docs/specs/`);
      else specs.push(value);
    } else if (key === 'Criteria') {
      if (!CRITERIA_VALUE.test(value)) {
        problems.push(`Criteria: "${value}" is not a comma-separated list of criterion ids`);
      } else {
        for (const id of value.split(', ')) {
          if (targets.criteria.has(id)) criteria.push(id);
          else problems.push(`Criteria: ${id} is not a criterion in docs/specs/`);
        }
      }
    } else if (key.toLowerCase() === 'co-authored-by') {
      if (/\bclaude\b/i.test(value)) claudeCoAuthor = true;
    } else {
      const meant = NEAR_MISSES[key.toLowerCase()];
      if (meant !== undefined) problems.push(`${key}: is a near miss of the trailer key "${meant}:"`);
    }
  }
  if (agents.length > 1) problems.push(`Agent: appears ${agents.length} times; a commit has at most one Agent trailer`);
  if (claudeCoAuthor && agents.length === 0) problems.push('Co-Authored-By names Claude, but there is no Agent trailer');
  return { trailers: { agent: agents[0] ?? null, specs, criteria }, problems };
}

function main(words: readonly string[]): number {
  const flag = words.indexOf('--message');
  const path = flag === -1 ? undefined : words[flag + 1];
  if (path === undefined) {
    console.error('usage: node tools/check-commit-trailers.ts --message <file>');
    return 2;
  }
  const { problems } = readCommitTrailers(readFileSync(path, 'utf8'), readTargets(process.cwd()));
  for (const problem of problems) console.error(`commit trailers: ${problem}`);
  console.log(problems.length === 0 ? 'commit trailers passed' : `commit trailers failed: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
