// Every third-party package on the trust path needs a dependency review, and a review that fails a
// check cannot keep its package on the default path. The trust path is every package that
// package-lock.json installs as a non-development dependency of a workspace package, with the
// packages those depend on in turn. Development-only tools (the compiler, Node's types, the
// browser installer) are off it; browser builds are locked separately.
// The lint fails when such a package has no review; when a review's version is not the exact
// version in the lock file and in every manifest that names it; when a check fails and the
// decision is `default`; when evidence that is a repository path does not exist; or when evidence
// that names a test does not match one in that file. A `partial` result does not fail. The reviews
// are in tools/repo-rules/docs/DependencyReviews.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPENDENCY_REVIEWS, type DependencyReview } from './DependencyReviews.ts';
import type { Token } from '../naming/LintRepository.ts';
import { closingParenthesis, CODE_FILE, codeTokens, isPunctuator } from '../ListSourceFiles.ts';
import { readWorkspacePackages, reportProblems } from '../ReadWorkspacePackages.ts';

const SUITE_CALLS = new Set(['describe', 'suite']);
const TEST_CALLS = new Set([...SUITE_CALLS, 'test', 'it']);
const TEST_CALL_MODIFIERS = new Set(['only', 'skip', 'todo']);

type LockEntry = { readonly version?: unknown; readonly dev?: unknown; readonly dependencies?: unknown; readonly optionalDependencies?: unknown; readonly peerDependencies?: unknown };

// The fields of a JSON object, copied once; undefined for anything else.
const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;

const namesOf = (value: unknown): string[] => Object.keys(fieldsOf(value) ?? {});

// The lock file's installed packages by path, or undefined when it has no packages object, so the
// trust path cannot be read. An entry of any other shape counts as none.
function lockPackages(lock: unknown): Readonly<Record<string, LockEntry>> | undefined {
  const listed = fieldsOf(fieldsOf(lock)?.['packages']);
  if (listed === undefined) {
    return undefined;
  }
  const packages: Record<string, LockEntry> = {};
  for (const [path, value] of Object.entries(listed)) {
    const fields = fieldsOf(value);
    if (fields !== undefined) {
      packages[path] = {
        version: fields['version'],
        dev: fields['dev'],
        dependencies: fields['dependencies'],
        optionalDependencies: fields['optionalDependencies'],
        peerDependencies: fields['peerDependencies'],
      };
    }
  }
  return packages;
}

// What a package depends on at run time, as its lock entry or manifest lists it.
const runtimeNames = (entry: LockEntry): string[] =>
  [...namesOf(entry.dependencies), ...namesOf(entry.optionalDependencies), ...namesOf(entry.peerDependencies)];

// The installed lock entry a package's dependency resolves to: nested under it first, then hoisted.
function installedEntry(packages: Readonly<Record<string, LockEntry>>, from: string, name: string): { readonly path: string; readonly entry: LockEntry } | undefined {
  const nested = `${from === '' ? '' : `${from}/`}node_modules/${name}`;
  for (const path of [nested, `node_modules/${name}`]) {
    const entry = packages[path];
    if (entry !== undefined) return { path, entry };
  }
  return undefined;
}

// Each third-party package on the trust path and the version the lock file installs, or undefined
// when the lock file does not list its installed packages.
export function trustPath(root: string): Map<string, string> | undefined {
  const lock: unknown = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const packages = lockPackages(lock);
  if (packages === undefined) {
    return undefined;
  }
  const workspaces = Object.keys(packages).filter((path) => path.startsWith('packages/'));
  const found = new Map<string, string>();
  const queue: { readonly from: string; readonly name: string }[] = [];
  for (const workspace of workspaces) {
    const entry = packages[workspace];
    if (entry !== undefined) for (const name of runtimeNames(entry)) queue.push({ from: workspace, name });
  }
  const visited = new Set<string>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const installed = installedEntry(packages, next.from, next.name);
    // Workspace packages are ours, not third-party; they link to packages/.
    if (installed === undefined || next.name.startsWith('@revisum/') || visited.has(installed.path)) continue;
    visited.add(installed.path);
    if (installed.entry.dev === true) continue;
    found.set(next.name, typeof installed.entry.version === 'string' ? installed.entry.version : 'unknown');
    for (const name of runtimeNames(installed.entry)) queue.push({ from: installed.path, name });
  }
  return found;
}

// The version each workspace manifest asks for, per package name.
function manifestVersions(root: string): Map<string, { readonly folder: string; readonly version: string }[]> {
  const versions = new Map<string, { readonly folder: string; readonly version: string }[]>();
  for (const workspacePackage of readWorkspacePackages(root)) {
    const manifestPath = join(workspacePackage.path, 'package.json');
    const manifest: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const listed: unknown = typeof manifest === 'object' && manifest !== null ? Object.getOwnPropertyDescriptor(manifest, field)?.value : undefined;
      if (typeof listed !== 'object' || listed === null) continue;
      for (const [name, version] of Object.entries(listed)) {
        const list = versions.get(name) ?? [];
        list.push({ folder: workspacePackage.folder, version: String(version) });
        versions.set(name, list);
      }
    }
  }
  return versions;
}

// Evidence that names a file in this repository: a path with a folder and an extension, or a test
// id whose file part is one. URLs and plain descriptions are not checked.
function evidencePath(evidence: string): string | undefined {
  if (/^[a-z]+:\/\//i.test(evidence)) return undefined;
  const path = evidence.split('#')[0] ?? '';
  return /^[\w.-]+(?:\/[\w.-]+)+\.\w+$/.test(path) ? path : undefined;
}

// A test's title as the runner reports it, or undefined when it isn't one plain literal, as in a
// loop's `when it ${how}`. Source text keeps its escapes; the runner's title has none.
function literalTitle(tokens: readonly Token[], open: number): string | undefined {
  const title = tokens[open + 1];
  const isWholeArgument = isPunctuator(tokens[open + 2], ',') || isPunctuator(tokens[open + 2], ')');
  if (!isWholeArgument || (title?.kind !== 'string' && title?.kind !== 'template')) {
    return undefined;
  }
  return title.text.replace(/\\(.)/gs, '$1');
}

// The "(" of the node:test call starting at `index`: `test(…)`, or `test.only(…)` and its like.
function testCallOpening(tokens: readonly Token[], index: number): number | undefined {
  const token = tokens[index];
  if (token?.kind !== 'identifier' || !TEST_CALLS.has(token.text) || isPunctuator(tokens[index - 1], '.')) {
    return undefined;
  }
  const hasModifier = isPunctuator(tokens[index + 1], '.') && TEST_CALL_MODIFIERS.has(tokens[index + 2]?.text ?? '');
  const opening = hasModifier ? index + 3 : index + 1;
  return isPunctuator(tokens[opening], '(') ? opening : undefined;
}

// Whether a test file has a test with this full name. A title that isn't a plain literal matches any
// text, since only a run can say what it becomes; the titles around it still have to match.
function namesTest(source: string, name: string): boolean {
  const tokens = codeTokens(source);
  const open: { readonly title: string | undefined; readonly closesAt: number }[] = [];
  const titlesOfTests: (readonly (string | undefined)[])[] = [];
  tokens.forEach((token, index) => {
    while ((open.at(-1)?.closesAt ?? index) < index) {
      open.pop();
    }
    const opening = testCallOpening(tokens, index);
    if (opening === undefined) {
      return;
    }
    const title = literalTitle(tokens, opening);
    if (!SUITE_CALLS.has(token.text)) {
      titlesOfTests.push([...open.map((around) => around.title), title]);
    }
    open.push({ title, closesAt: closingParenthesis(tokens, opening) });
  });
  return titlesOfTests.some((titles) => {
    const pattern = titles.map((title) => (title === undefined ? '.+' : title.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))).join(' > ');
    return new RegExp(`^${pattern}$`, 's').test(name);
  });
}

// The test's full name when `evidence`, already known to name `path`, also names a test in a code file.
const evidenceTestName = (evidence: string, path: string): string | undefined =>
  evidence.length > path.length && CODE_FILE.test(path) ? evidence.slice(path.length + 1) : undefined;

export function checkDependencyReviews(root: string, reviews: readonly DependencyReview[] = DEPENDENCY_REVIEWS): string[] {
  const problems: string[] = [];
  const installed = trustPath(root);
  if (installed === undefined) {
    return ['package-lock.json lists no installed packages, so the trust path cannot be read'];
  }
  const requested = manifestVersions(root);
  const reviewed = new Map(reviews.map((review) => [review.component, review]));
  for (const [name, version] of [...installed].sort(([left], [right]) => left.localeCompare(right))) {
    const review = reviewed.get(name);
    if (review === undefined) {
      problems.push(`${name} ${version} is on the trust path but has no dependency review in tools/repo-rules/docs/DependencyReviews.ts`);
      continue;
    }
    if (review.version !== version) problems.push(`${name}: the review is of ${review.version}, but the lock file installs ${version}`);
    for (const manifest of requested.get(name) ?? []) {
      if (manifest.version !== review.version) problems.push(`${name}: packages/${manifest.folder}/package.json asks for ${manifest.version}, not the reviewed ${review.version} exactly`);
    }
  }
  for (const review of reviews) {
    const failing = Object.entries(review.results).filter(([, result]) => result === 'fail').map(([check]) => check);
    if (review.decision === 'default' && failing.length > 0) {
      problems.push(`${review.component} fails ${failing.join(', ')}, so it cannot stay on the default path; make it an optional adapter or drop it`);
    }
    for (const evidence of review.evidence) {
      const path = evidencePath(evidence);
      if (path === undefined) {
        continue;
      }
      if (!existsSync(join(root, path))) {
        problems.push(`${review.component}: the evidence ${path} does not exist`);
        continue;
      }
      const testName = evidenceTestName(evidence, path);
      if (testName !== undefined && !namesTest(readFileSync(join(root, path), 'utf8'), testName)) {
        problems.push(`${review.component}: the evidence ${path} has no test named "${testName}"; name a test as its results do, with the titles around it joined by " > "`);
      }
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('dependency review check', checkDependencyReviews(process.cwd()));
