// The project's own metrics, recorded by the gates step at the end of every CI run, after the
// tests (tools/run-test-folder.ts) have written their results to .test-results/:
//   - agentAuthoredShare: commits with an Agent trailer over commits since the trailer cut-over;
//   - specLinkedShare: commits with a Spec or Criteria trailer over the same commits;
//   - tracedCriteriaShare: criteria defined in docs/specs/ with at least one passing tagged test
//     in this run, over every criterion defined there, with a breakdown per spec;
//   - flakyRunRate: 1 when a failed test file passed on its one measuring rerun, else 0.
// The approval behind every commit is the founder's push under the agent lock-down, so the record
// says `declared`, never verified. Commits up to and including the cut-over carry no trailers and
// cannot be rewritten, so they are only counted (beforeTrailers). A later commit with a malformed
// trailer fails the step, naming it, unless KNOWN_MALFORMED_COMMITS lists it.
// Writes .test-results/project-metrics.json, .test-results/project-metrics.md (the summary) and
// .test-results/trace-index.json (each criterion, its tests and their outcomes).
//   node tools/project-metrics.ts [--cut-over <commit>]
// The repository is the working folder; it must be a Git repository with its full history.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCommitTrailers, readTargets } from './check-commit-trailers.ts';
import { readSpecCriteria } from './spec-criteria.ts';
import { criterionReader, failed, readTestResults, RESULTS_FOLDER, type TestResults } from './test-results.ts';

// The commit that settled the trailer grammar; trailers are checked on its descendants only.
export const TRAILER_CUT_OVER = '8165795feae3c457955329b5cdafa883a6e65f62';

// Malformed commits made after the cut-over, which can't be rewritten: the commit, then why it is
// malformed. Adding one is a reviewed change the founder reads before pushing.
export const KNOWN_MALFORMED_COMMITS: readonly { readonly commit: string; readonly reason: string }[] = [];

// The run as SPEC-27's RunRecord in contracts describes it. Tools are compiled apart from the
// packages, so the shape is repeated here rather than imported.
export type ProjectRunRecord = {
  readonly runId: string;
  readonly changeClassId: string;
  readonly commit: string | null;
  readonly at: string;
  readonly criteriaInScope: number;
  readonly criteriaTraced: number;
  readonly passedFirstTime: boolean;
  readonly flakyPair: boolean;
  readonly decisions: readonly [];
};

export type TraceEntry = {
  readonly criterion: string;
  readonly traced: boolean;
  readonly tests: readonly { readonly testId: string; readonly passed: boolean; readonly skipped: boolean }[];
};

export type ProjectMetrics = {
  readonly run: ProjectRunRecord;
  readonly approvalStrength: 'declared';
  readonly cutOver: string;
  readonly beforeTrailers: number;
  readonly commitsSinceCutOver: number;
  readonly agentAuthoredShare: number;
  readonly specLinkedShare: number;
  readonly tracedCriteriaShare: number;
  readonly flakyRunRate: number;
  readonly tracedBySpec: readonly { readonly spec: string; readonly traced: number; readonly total: number; readonly share: number }[];
  readonly resultsFiles: readonly string[];
};

const git = (root: string, ...words: readonly string[]): string =>
  execFileSync('git', words, { cwd: root, encoding: 'utf8', ['maxBuffer']: 256 * 1024 * 1024 }).trim();

const shareOf = (count: number, total: number): number => (total === 0 ? 0 : count / total);

type CommitCounts = {
  readonly beforeTrailers: number;
  readonly since: number;
  readonly agentAuthored: number;
  readonly specLinked: number;
  readonly malformed: readonly string[];
};

function countCommits(root: string, cutOver: string): CommitCounts {
  const targets = readTargets(root);
  const fullCutOver = git(root, 'rev-parse', '--verify', `${cutOver}^{commit}`);
  const beforeTrailers = Number(git(root, 'rev-list', '--count', fullCutOver));
  // Each commit as its hash, a unit separator, then its raw message, ended by a record separator.
  const log = git(root, 'log', '--format=%H%x1f%B%x1e', `${fullCutOver}..HEAD`);
  const commits = log.split('\x1e').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const known = new Set(KNOWN_MALFORMED_COMMITS.map((exception) => exception.commit));
  let agentAuthored = 0;
  let specLinked = 0;
  const malformed: string[] = [];
  for (const entry of commits) {
    const separator = entry.indexOf('\x1f');
    const commit = entry.slice(0, separator);
    const { trailers, problems } = readCommitTrailers(entry.slice(separator + 1), targets);
    if (trailers.agent !== null) agentAuthored += 1;
    if (trailers.specs.length > 0 || trailers.criteria.length > 0) specLinked += 1;
    if (problems.length > 0 && ![...known].some((exception) => commit.startsWith(exception))) {
      malformed.push(`${commit.slice(0, 12)}: ${problems.join('; ')}`);
    }
  }
  return { beforeTrailers, since: commits.length, agentAuthored, specLinked, malformed };
}

function traceCriteria(root: string, results: TestResults): TraceEntry[] {
  const specs = readSpecCriteria(root);
  const criterionOf = criterionReader(root);
  const testsByCriterion = new Map<string, TraceEntry['tests'][number][]>();
  for (const test of results.tests.values()) {
    const criterion = criterionOf(test);
    if (criterion === undefined) continue;
    const tests = testsByCriterion.get(criterion) ?? [];
    tests.push({ testId: test.testId, passed: test.passed, skipped: test.skipped });
    testsByCriterion.set(criterion, tests);
  }
  return [...specs.all].sort().map((criterion) => {
    const tests = testsByCriterion.get(criterion) ?? [];
    return { criterion, traced: tests.some((test) => test.passed), tests };
  });
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

function summary(metrics: ProjectMetrics): string {
  return [
    '# Project metrics',
    '',
    `Run ${metrics.run.runId} at ${metrics.run.at}, commit ${metrics.run.commit ?? 'unknown'}.`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Traced criteria share | ${percent(metrics.tracedCriteriaShare)} (${metrics.run.criteriaTraced} of ${metrics.run.criteriaInScope}) |`,
    `| Flaky run rate | ${metrics.flakyRunRate} |`,
    `| Agent-authored share | ${percent(metrics.agentAuthoredShare)} of ${metrics.commitsSinceCutOver} commits since the trailer cut-over |`,
    `| Spec-linked share | ${percent(metrics.specLinkedShare)} of ${metrics.commitsSinceCutOver} commits since the trailer cut-over |`,
    `| Commits before trailers | ${metrics.beforeTrailers} |`,
    '',
    'Approval: declared, not verified. Every change reaches the default branch by the founder\'s own push',
    'under the agent lock-down: the coding agent is denied push, merge and pull-request approval.',
    'No second account reviews it, so these metrics rest on a declared approval.',
    '',
  ].join('\n');
}

export function recordProjectMetrics(root: string, cutOver: string): { readonly metrics: ProjectMetrics; readonly malformed: readonly string[] } {
  const commits = countCommits(root, cutOver);
  const results = readTestResults(root);
  const trace = traceCriteria(root, results);
  const traced = trace.filter((entry) => entry.traced).length;
  const flakyPair = results.reruns.some((rerun) => rerun.passed);
  const specs = readSpecCriteria(root);
  const tracedSet = new Set(trace.filter((entry) => entry.traced).map((entry) => entry.criterion));
  const tracedBySpec = [...specs.bySpec].sort(([left], [right]) => left.localeCompare(right)).map(([spec, criteria]) => {
    const count = criteria.filter((criterion) => tracedSet.has(criterion)).length;
    return { spec: `SPEC-${spec}`, traced: count, total: criteria.length, share: shareOf(count, criteria.length) };
  });
  const run: ProjectRunRecord = {
    runId: process.env['GITHUB_RUN_ID'] ?? `local-${Date.now()}`,
    changeClassId: 'project-build',
    commit: git(root, 'rev-parse', 'HEAD'),
    at: new Date().toISOString(),
    criteriaInScope: trace.length,
    criteriaTraced: traced,
    passedFirstTime: ![...results.tests.values()].some(failed),
    flakyPair,
    decisions: [],
  };
  const metrics: ProjectMetrics = {
    run,
    approvalStrength: 'declared',
    cutOver,
    beforeTrailers: commits.beforeTrailers,
    commitsSinceCutOver: commits.since,
    agentAuthoredShare: shareOf(commits.agentAuthored, commits.since),
    specLinkedShare: shareOf(commits.specLinked, commits.since),
    tracedCriteriaShare: shareOf(traced, trace.length),
    flakyRunRate: flakyPair ? 1 : 0,
    tracedBySpec,
    resultsFiles: results.files,
  };
  const folder = join(root, RESULTS_FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'project-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(join(folder, 'project-metrics.md'), summary(metrics));
  writeFileSync(join(folder, 'trace-index.json'), `${JSON.stringify(trace, null, 2)}\n`);
  return { metrics, malformed: commits.malformed };
}

function main(words: readonly string[]): number {
  const flag = words.indexOf('--cut-over');
  const cutOver = flag === -1 ? TRAILER_CUT_OVER : words[flag + 1];
  if (cutOver === undefined) {
    console.error('usage: node tools/project-metrics.ts [--cut-over <commit>]');
    return 2;
  }
  const { metrics, malformed } = recordProjectMetrics(process.cwd(), cutOver);
  console.log(summary(metrics));
  for (const problem of malformed) console.error(`malformed commit trailers in ${problem}`);
  if (malformed.length > 0) {
    console.error(`project metrics failed: ${malformed.length} commit(s) after the cut-over have malformed trailers`);
    return 1;
  }
  console.log(`project metrics written to ${RESULTS_FOLDER}/`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
