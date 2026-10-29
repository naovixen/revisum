// Throw-away repositories for the trust and approval tests, built from the fixture repositories in
// fixtures/approval-repositories/<name>.json. Each fixture describes:
//   - protectedFiles: the files on the protected default branch, as the version-control port
//     serves them (a string is served as its text, anything else as canonical JSON);
//   - workingCopy: the change under test's own versions of the files it edits;
//   - landings: which account landed which commit on which branch, and when;
//   - pullRequests: each pull request's author, head commit, reviews, changed files and the last
//     commit in it that touched each path;
//   - filesAtCommits (optional): the files a commit holds where they differ from the protected
//     branch, by commit then path. Any other file at any commit is served as the protected
//     branch's, as if every reviewed commit had already landed unchanged.
// Every repository also gets the sign-up plan at plans/signup.json and a holdouts.json that lists
// one holdout plan's hash, so each subject kind has something on the protected branch.
//
// The working copy is written to a temporary folder, so a test can show that core reads trusted
// files from the protected branch and not from the change. Nothing here touches a real git remote.
//
// The names below follow SPEC-02's build notes. Three shapes the notes leave unnamed are used only
// in this file, so settling them changes one place:
//   - the loader's `change` argument is { files, events }: the files the change edits, and the
//     sink its trusted.changed-with-code events go to; its result is { project, reviewItems };
//   - pullRequest(number) answers { author, headCommit }, the author as a login;
//   - lastCommitTouching(path, pullRequest) answers the commit id;
//   - fileAtCommit(path, commit) answers { bytes }, the file at `path` as `commit` holds it, or
//     'not-found' when that commit has no such file.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  approvalVerifier, canonicalJson, failure, loadTrustedProject, planHash, sha256, success,
  type Approval, type ApprovalErrorCode, type ApprovalProof, type ApprovalStore, type ApprovalSubject,
  type ApprovalVerifier, type DerivedActor, type EventInput, type EventSink, type Plan, type Result,
  type TrustedProject, type VersionControlPort, type VersionControlReview,
} from '@revisum/engine';
import { memoryEventSink, type MemoryEventSink, type RecordedEvent } from '../../support/memory-ports.ts';
import { FIXTURES } from '../../support/repository.ts';
import { defaultParser, signupPlan, type JsonRecord } from './plan-examples.ts';

export const PLAN_PATH = 'plans/signup.json';
export const PROJECT_PATH = 'project.json';
export const APPROVERS_PATH = 'approvers.json';
export const CODE_OWNERS_PATH = '.github/CODEOWNERS';
export const DENY_RULES_PATH = '.claude/settings.json';
export const HOLDOUTS_PATH = 'holdouts.json';

// The key the approval verifier pseudonymises identities under. A test value, not a secret.
export const ACTOR_KEY = 'approval-test-actor-key';

export type AccountType = 'user' | 'bot' | 'app';
export type Landing = { commit: string; branch: string; login: string; type: AccountType; at: string };
export type ChangedFile = { path: string; authors: string[] };
export type PullRequest = {
  author: string;
  headCommit: string;
  lastCommitTouching: Record<string, string>;
  changedFiles: ChangedFile[];
  reviews: VersionControlReview[];
};

export type FixtureRepository = {
  description: string;
  repository: string;
  protectedBranch: string;
  protectedCommit: string;
  protectedFiles: Record<string, unknown>;
  workingCopy: Record<string, unknown>;
  landings: Landing[];
  pullRequests: Record<string, PullRequest>;
  filesAtCommits?: Record<string, Record<string, unknown>>;
};

export type RepositoryName = 'solo' | 'team' | 'red-team';
export type SubjectKind = ApprovalSubject['kind'];
export type PortMethod = 'protectedFile' | 'reviews' | 'changedFiles' | 'landedBy' | 'pullRequest' | 'lastCommitTouching' | 'fileAtCommit';

// A holdout plan lives in the holdout store, never in the repository; holdouts.json on the
// protected branch lists its hash by change class.
const HOLDOUT_PLAN = { changeClassId: 'checkout', title: 'Checkout totals survive a refund' };
export const HOLDOUT_PLAN_HASH = sha256(canonicalJson(HOLDOUT_PLAN));

// The sign-up plan as the parser returns it. Its file on the protected branch holds its canonical
// JSON, so the file's SHA-256 and the plan's hash agree.
export function parsedSignupPlan(input: JsonRecord = signupPlan()): Plan {
  const parsed = defaultParser()(input);
  if (!parsed.ok) throw new Error(`the sign-up plan was rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// A path as the fixture keys it: forward slashes, no leading "./" or "/".
const repositoryFile = (path: string): string => path.replaceAll('\\', '/').replace(/^\.?\//, '');

const fileBytes = (content: unknown): Uint8Array =>
  Buffer.from(typeof content === 'string' ? content : canonicalJson(content), 'utf8');

export function readFixture(name: RepositoryName): FixtureRepository {
  const fixture: FixtureRepository = JSON.parse(readFileSync(join(FIXTURES, 'approval-repositories', `${name}.json`), 'utf8'));
  fixture.protectedFiles[PLAN_PATH] ??= parsedSignupPlan();
  fixture.protectedFiles[HOLDOUTS_PATH] ??= { changeClasses: [{ changeClassId: 'checkout', planHashes: [HOLDOUT_PLAN_HASH] }] };
  return fixture;
}

// The in-memory audit sink lives with the other in-memory ports; it is re-exported here for the
// tests that already import it from this file.
export { memoryEventSink, type MemoryEventSink, type RecordedEvent };

export const eventsOfKind = (events: MemoryEventSink, kind: EventInput['kind']): readonly RecordedEvent[] =>
  events.recorded.filter((recorded) => recorded.event.kind === kind);

export function memoryApprovalStore(approvals: readonly Approval[]): ApprovalStore {
  return { forSubject: (subjectHash) => approvals.filter((approval) => approval.subject.hash === subjectHash) };
}

// What loading the project for one change gives back, in the shape this file assumes.
export type LoadedProject = Awaited<ReturnType<typeof loadTrustedProject>>;

// Loads project.json for a change that edits `files`, with its events going to `events`.
export const loadForChange = (versionControl: VersionControlPort, files: readonly string[], events: EventSink): Promise<LoadedProject> =>
  loadTrustedProject(PROJECT_PATH, versionControl, { files, events });

export type TestRepository = {
  readonly fixture: FixtureRepository;
  // The folder holding the working copy: the protected files with the change's edits on top.
  readonly root: string;
  // Events the approval verifier appends.
  readonly events: MemoryEventSink;
  // Events the trusted-project loader appends.
  readonly loaderEvents: MemoryEventSink;
  readonly verifier: ApprovalVerifier;
  // Every port call, as "method argument", in order.
  readonly calls: readonly string[];
  // The version-control port; the methods named in `unavailable` answer 'unavailable'.
  versionControl(unavailable?: readonly PortMethod[]): VersionControlPort;
  trustedProject(): Promise<TrustedProject>;
  subject(kind: SubjectKind): ApprovalSubject;
  codeOwnerProof(reviewId: string, overrides?: { pullRequest?: number; commit?: string }): ApprovalProof;
  lockdownProof(overrides?: { protectedBranch?: string; commit?: string; mergedBy?: string }): ApprovalProof;
  verify(subject: ApprovalSubject, proof: ApprovalProof, unavailable?: readonly PortMethod[]):
    Promise<Result<{ approval: Approval; actor: DerivedActor }, ApprovalErrorCode>>;
  dispose(): void;
};

// The path of a subject of each kind on the protected branch.
export const SUBJECT_PATHS: Readonly<Record<SubjectKind, string>> = {
  'plan': PLAN_PATH,
  'trusted-file': 'baselines/checkout.json',
  'review-decision': 'reviews/decisions/checkout-contrast.json',
  'extra-review': 'reviews/extra/payments.json',
  'holdout-plan': HOLDOUTS_PATH,
};
export const SUBJECT_KINDS = Object.keys(SUBJECT_PATHS) as SubjectKind[];

export function openRepository(name: RepositoryName, edit: (fixture: FixtureRepository) => void = () => {}): TestRepository {
  const fixture = readFixture(name);
  edit(fixture);
  const root = mkdtempSync(join(tmpdir(), `approval-${name}-`));
  for (const [path, content] of Object.entries({ ...fixture.protectedFiles, ...fixture.workingCopy })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), fileBytes(content));
  }
  const calls: string[] = [];
  const events = memoryEventSink();
  const loaderEvents = memoryEventSink();
  const verifier = approvalVerifier({ events, actorKey: ACTOR_KEY });

  const versionControl = (unavailable: readonly PortMethod[] = []): VersionControlPort => {
    const down = new Set<PortMethod>(unavailable);
    const pullRequestNumbered = (number: number): PullRequest | undefined => fixture.pullRequests[String(number)];
    const port: Omit<VersionControlPort, 'fileAtCommit'> = {
      protectedBranch: fixture.protectedBranch,
      async protectedFile(path) {
        calls.push(`protectedFile ${path}`);
        if (down.has('protectedFile')) return failure('unavailable');
        const content = fixture.protectedFiles[repositoryFile(path)];
        return content === undefined ? failure('not-found') : success({ bytes: fileBytes(content), commit: fixture.protectedCommit });
      },
      async reviews(number) {
        calls.push(`reviews ${number}`);
        if (down.has('reviews')) return failure('unavailable');
        return success(pullRequestNumbered(number)?.reviews ?? []);
      },
      async changedFiles(number) {
        calls.push(`changedFiles ${number}`);
        if (down.has('changedFiles')) return failure('unavailable');
        return success(pullRequestNumbered(number)?.changedFiles ?? []);
      },
      async pullRequest(number) {
        calls.push(`pullRequest ${number}`);
        if (down.has('pullRequest')) return failure('unavailable');
        const found = pullRequestNumbered(number);
        return found === undefined ? failure('unavailable') : success({ author: found.author, headCommit: found.headCommit });
      },
      async lastCommitTouching(path, number) {
        calls.push(`lastCommitTouching ${path} ${number}`);
        if (down.has('lastCommitTouching')) return failure('unavailable');
        const commit = pullRequestNumbered(number)?.lastCommitTouching[path];
        return commit === undefined ? failure('unavailable') : success(commit);
      },
      async landedBy(commit, branch) {
        calls.push(`landedBy ${commit} ${branch}`);
        if (down.has('landedBy')) return failure('unavailable');
        const landing = fixture.landings.find((candidate) => candidate.commit === commit && candidate.branch === branch);
        return success(landing === undefined ? null : { login: landing.login, type: landing.type, at: landing.at });
      },
    };
    // Added beside the literal, not inside it, so this file compiles whether or not the port
    // declares the method yet. A commit's file is its own version where the fixture gives one, and
    // otherwise the protected branch's.
    return Object.assign(port, {
      async fileAtCommit(path: string, commit: string): Promise<Result<{ readonly bytes: Uint8Array }, 'not-found' | 'unavailable'>> {
        calls.push(`fileAtCommit ${path} ${commit}`);
        if (down.has('fileAtCommit')) return failure('unavailable');
        const file = repositoryFile(path);
        const atCommit = fixture.filesAtCommits?.[commit];
        const content = atCommit !== undefined && file in atCommit ? atCommit[file] : fixture.protectedFiles[file];
        return content === undefined ? failure('not-found') : success({ bytes: fileBytes(content) });
      },
    });
  };

  const repository: TestRepository = {
    fixture, root, events, loaderEvents, verifier, calls, versionControl,
    async trustedProject() {
      const loaded = await loadForChange(versionControl(), [], loaderEvents);
      if (!loaded.ok) throw new Error(`the ${name} repository's project was not trusted: ${JSON.stringify(loaded.error)}`);
      return loaded.value.project;
    },
    subject(kind) {
      const path = SUBJECT_PATHS[kind];
      if (kind === 'plan') return { kind, hash: planHash(parsedSignupPlan()), path };
      if (kind === 'holdout-plan') return { kind, hash: HOLDOUT_PLAN_HASH, path };
      const content = fixture.protectedFiles[path];
      if (content === undefined) throw new Error(`the ${name} repository has no ${path} on its protected branch`);
      return { kind, hash: sha256(fileBytes(content)), path };
    },
    codeOwnerProof(reviewId, overrides = {}) {
      const pullRequest = overrides.pullRequest ?? Number(Object.keys(fixture.pullRequests)[0]);
      return {
        kind: 'code-owner-review', provider: 'github', repository: fixture.repository, pullRequest, reviewId,
        commit: overrides.commit ?? fixture.pullRequests[String(pullRequest)]?.headCommit ?? 'commit-pull-head',
      };
    },
    lockdownProof(overrides = {}) {
      const maintainer = approversOf(fixture).agentLockdown?.maintainer ?? 'maintainer-mia';
      return {
        kind: 'agent-lockdown-merge', provider: 'github', repository: fixture.repository,
        protectedBranch: overrides.protectedBranch ?? fixture.protectedBranch,
        commit: overrides.commit ?? fixture.protectedCommit,
        mergedBy: overrides.mergedBy ?? maintainer,
      };
    },
    async verify(subject, proof, unavailable = []) {
      const trusted = await repository.trustedProject();
      return verifier.verify(subject, proof, trusted, versionControl(unavailable));
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
  return repository;
}

// Runs `body` against a fresh repository and removes the repository afterwards.
export async function withRepository(
  name: RepositoryName, body: (repository: TestRepository) => Promise<void>, edit?: (fixture: FixtureRepository) => void,
): Promise<void> {
  const repository = openRepository(name, edit);
  try {
    await body(repository);
  } finally {
    repository.dispose();
  }
}

// A refusal: the verifier returns `code`, appends no plan.approved event, and appends an
// approval.refused event that carries the code.
export function assertRefused(
  repository: TestRepository, verified: Result<{ approval: Approval; actor: DerivedActor }, ApprovalErrorCode>, code: ApprovalErrorCode,
): void {
  if (verified.ok) throw new Error(`expected ${code}, but the approval verified as ${verified.value.approval.strength}`);
  if (verified.error !== code) throw new Error(`expected ${code}, got ${verified.error}`);
  if (eventsOfKind(repository.events, 'plan.approved').length !== 0) throw new Error('a refused attempt left a plan.approved event');
  const refused = eventsOfKind(repository.events, 'approval.refused');
  if (!refused.some(({ event }) => JSON.stringify(event).includes(code))) {
    throw new Error(`no approval.refused event carries ${code}: ${JSON.stringify(repository.events.recorded)}`);
  }
}

// ---- Fixture edits ------------------------------------------------------------------------------

type DenyRules = { permissions: { allow?: string[]; deny: string[] } };
type Approvers = {
  agentLockdown?: { maintainer: string; agentDenyRulesPath: string; deniedActions: string[]; agentHasGithubCredentials: boolean };
  signingKeys?: unknown[];
};

export const denyRulesOf = (fixture: FixtureRepository): DenyRules => fixture.protectedFiles[DENY_RULES_PATH] as DenyRules;
export const approversOf = (fixture: FixtureRepository): Approvers => (fixture.protectedFiles[APPROVERS_PATH] ?? {}) as Approvers;

// Removes every deny rule that matches `pattern` from the protected-branch deny-rules file.
export const withoutDenyRules = (pattern: RegExp) => (fixture: FixtureRepository): void => {
  const rules = denyRulesOf(fixture);
  rules.permissions.deny = rules.permissions.deny.filter((rule) => !pattern.test(rule));
};
