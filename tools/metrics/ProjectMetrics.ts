// The project's own metrics, recorded by the gates step at the end of every CI run, after the
// tests (tools/test-runner/RunTestFolder.ts) have written their results to .test-results/:
//   - agentAuthoredShare: commits with an Agent trailer over commits since the trailer cut-over;
//   - specLinkedShare: commits with a Spec or Criteria trailer over the same commits;
//   - flakyRunRate: 1 when a failed test file passed on its one measuring rerun, else 0.
// The approval behind every commit is the founder's push under the agent lock-down, so the record
// says `declared`, never verified. Commits up to and including the cut-over carry no trailers and
// cannot be rewritten, so they are only counted (beforeTrailers). A later commit with a malformed
// trailer fails the step, naming it, unless KNOWN_MALFORMED_COMMITS lists it.
// A criterion counts as traced when a commit since the cut-over names it in a Criteria trailer.
// Writes .test-results/project-metrics.json and .test-results/project-metrics.md (the summary).
//   node tools/metrics/ProjectMetrics.ts [--cut-over <commit>]
// The repository is the working folder; it must be a Git repository with its full history.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCommitTrailers, readTargets } from '../repo-rules/commits/CommitTrailers.ts';
import { readSpecCriteria } from '../repo-rules/ReadSpecCriteria.ts';
import { failed, readTestResults, RESULTS_FOLDER } from '../test-runner/ReadTestResults.ts';

// The commit that settled the trailer grammar; trailers are checked on its descendants only.
export const TRAILER_CUT_OVER = '8165795feae3c457955329b5cdafa883a6e65f62';

// Malformed commits made after the cut-over, which can't be rewritten: the commit, then why it is
// malformed. Adding one is a reviewed change the founder reads before pushing.
export const KNOWN_MALFORMED_COMMITS: readonly { readonly commit: string; readonly reason: string }[] = [
  { commit: '892d0fee9be98a1cfb6a1e46d9096bf1d1744e07', reason: 'Spec trailer lists several specs on one line; one Spec line per spec is required (SPEC-35, SPEC-36)' },
  { commit: '2573b99bff238c48b748a04763dd50af7d06ed81', reason: 'Spec trailer lists several specs on one line; one Spec line per spec is required (SPEC-02, SPEC-03)' },
  { commit: 'd2f2afb3e32ce939dd7df11643fe42028190bf60', reason: 'Spec trailer lists several specs on one line; one Spec line per spec is required (SPEC-02, SPEC-03, SPEC-00)' },
  { commit: '4f0473cac1d0ff61e962a7ab73b48c31dae2a1b9', reason: 'Spec trailer lists several specs on one line; one Spec line per spec is required (SPEC-02, SPEC-03, SPEC-00)' },
  { commit: '701099c381859adc6bdef8c58308e1d2a92290ef', reason: 'Wrong message and Spec trailer (reads as the SPEC-33 record); the commit holds the SPEC-34 driver-parts alignment note' },
  { commit: '2a1df21b5930457d4412bdcaa00e73618c2fb929', reason: 'Agent trailer has no version (claude-code); the commit holds the SPEC-36 page-parts alignment note' },
];

// The run as RunRecord in contracts describes it. Tools are compiled apart from the
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

export type ProjectMetrics = {
  readonly run: ProjectRunRecord;
  readonly approvalStrength: 'declared';
  readonly cutOver: string;
  readonly beforeTrailers: number;
  readonly commitsSinceCutOver: number;
  readonly agentAuthoredShare: number;
  readonly specLinkedShare: number;
  readonly flakyRunRate: number;
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
  readonly criteriaNamed: ReadonlySet<string>;
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
  const criteriaNamed = new Set<string>();
  for (const entry of commits) {
    const separator = entry.indexOf('\x1f');
    const commit = entry.slice(0, separator);
    const { trailers, problems } = readCommitTrailers(entry.slice(separator + 1), targets);
    if (trailers.agent !== null) agentAuthored += 1;
    for (const criterion of trailers.criteria) criteriaNamed.add(criterion);
    if (trailers.specs.length > 0 || trailers.criteria.length > 0) specLinked += 1;
    if (problems.length > 0 && ![...known].some((exception) => commit.startsWith(exception))) {
      malformed.push(`${commit.slice(0, 12)}: ${problems.join('; ')}`);
    }
  }
  return { beforeTrailers, since: commits.length, agentAuthored, specLinked, malformed, criteriaNamed };
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
    `| Criteria named in a Criteria trailer | ${metrics.run.criteriaTraced} of ${metrics.run.criteriaInScope} |`,
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
  const definedCriteria = readSpecCriteria(root).all;
  const traced = [...commits.criteriaNamed].filter((criterion) => definedCriteria.has(criterion)).length;
  const flakyPair = results.reruns.some((rerun) => rerun.passed);
  const run: ProjectRunRecord = {
    runId: process.env['GITHUB_RUN_ID'] ?? `local-${Date.now()}`,
    changeClassId: 'project-build',
    commit: git(root, 'rev-parse', 'HEAD'),
    at: new Date().toISOString(),
    criteriaInScope: definedCriteria.size,
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
    flakyRunRate: flakyPair ? 1 : 0,
    resultsFiles: results.files,
  };
  const folder = join(root, RESULTS_FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'project-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(join(folder, 'project-metrics.md'), summary(metrics));
  return { metrics, malformed: commits.malformed };
}

function main(words: readonly string[]): number {
  const flag = words.indexOf('--cut-over');
  const cutOver = flag === -1 ? TRAILER_CUT_OVER : words[flag + 1];
  if (cutOver === undefined) {
    console.error('usage: node tools/metrics/ProjectMetrics.ts [--cut-over <commit>]');
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
