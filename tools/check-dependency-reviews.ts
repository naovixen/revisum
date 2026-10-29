// Every third-party package on the trust path needs a dependency review, and a review that fails a
// check cannot keep its package on the default path. The trust path is every package that
// package-lock.json installs as a non-development dependency of a workspace package, with the
// packages those depend on in turn. Development-only tools (the compiler, Node's types, the
// browser installer) are off it; browser builds are locked separately.
// The lint fails when such a package has no review; when a review's version is not the exact
// version in the lock file and in every manifest that names it; when a check fails and the
// decision is `default`; or when evidence that is a repository path does not exist. A `partial`
// result does not fail. The reviews are in tools/dependency-reviews.ts.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPENDENCY_REVIEWS } from './dependency-reviews.ts';
import { readWorkspacePackages, reportProblems } from './workspace-packages.ts';

// The checks every third-party component on the trust path must pass to stay on the default path.
export type DependencyCheck =
  | 'licenceAllowsUse'     // its licence permits commercial use and distribution
  | 'reachesAllTargets'    // it can drive or run on every target the product must support
  | 'versionPinned'        // an exact version can be pinned and run hermetically
  | 'stockBrowsersOnly'    // it needs no patched or vendor-only browser build
  | 'gapsClosable'         // any accessibility coverage gap can be closed around it
  | 'roadmapFits';         // its roadmap can't break the product's guarantees

export type DependencyCheckResult = 'pass' | 'fail' | 'partial';

// One review per third-party component on the trust path.
export type DependencyReview = {
  readonly component: string;
  // Exact and pinned.
  readonly version: string;
  readonly results: Readonly<Record<DependencyCheck, DependencyCheckResult>>;
  readonly decision: 'default' | 'optional-adapter' | 'dropped';
  // Test ids (<file>#<name>), licence files, repository docs or vendor URLs behind the results.
  readonly evidence: readonly string[];
};

type LockEntry = { readonly version?: unknown; readonly dev?: unknown; readonly dependencies?: unknown; readonly optionalDependencies?: unknown; readonly peerDependencies?: unknown };

const namesOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];

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

// Each third-party package on the trust path and the version the lock file installs.
export function trustPath(root: string): Map<string, string> {
  const lock: unknown = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const packagesField = typeof lock === 'object' && lock !== null ? Object.getOwnPropertyDescriptor(lock, 'packages')?.value : undefined;
  const packages: Readonly<Record<string, LockEntry>> = typeof packagesField === 'object' && packagesField !== null ? packagesField : {};
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

export function checkDependencyReviews(root: string, reviews: readonly DependencyReview[] = DEPENDENCY_REVIEWS): string[] {
  const problems: string[] = [];
  const installed = trustPath(root);
  const requested = manifestVersions(root);
  const reviewed = new Map(reviews.map((review) => [review.component, review]));
  for (const [name, version] of [...installed].sort(([left], [right]) => left.localeCompare(right))) {
    const review = reviewed.get(name);
    if (review === undefined) {
      problems.push(`${name} ${version} is on the trust path but has no dependency review in tools/dependency-reviews.ts`);
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
      if (path !== undefined && !existsSync(join(root, path))) problems.push(`${review.component}: the evidence ${path} does not exist`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('dependency review check', checkDependencyReviews(process.cwd()));
