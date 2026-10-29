// Every subject kind, not just a plan, is approved by the maintainer's declared approval exactly as
// by a verified one. Each fixture in fixtures/approval-subjects/ is one subject of a kind other than
// a plan: a trusted-file change, a review decision, a high-risk extra review and a holdout plan. Each
// is put on the protected branch (a holdout plan by its hash in holdouts.json), approved once by the
// maintainer's merge under agent lock-down and once by a code owner's review, and then:
//   - both approvals name the same subject and differ only in how they were given.
// SPEC-02 names a gate only for plans (planStanding and mergeGateOpen), so the other kinds' gates
// are tested with the specs that define them.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalLabel, canonicalJson, sha256, type Approval, type ApprovalSubject } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import {
  CODE_OWNERS_PATH, HOLDOUTS_PATH, withRepository, type FixtureRepository, type RepositoryName,
} from './approval-repositories.ts';

type SubjectFixture = {
  readonly description: string;
  readonly kind: Exclude<ApprovalSubject['kind'], 'plan'>;
  readonly path: string;
  readonly codeOwnersLine: string;
  readonly content: unknown;
};

const SUBJECT_FOLDER = join(FIXTURES, 'approval-subjects');
const subjectFixtures = (): readonly SubjectFixture[] => readdirSync(SUBJECT_FOLDER).filter((name) => name.endsWith('.json')).sort()
  .map((name): SubjectFixture => JSON.parse(readFileSync(join(SUBJECT_FOLDER, name), 'utf8')));

const subjectOf = (fixture: SubjectFixture): ApprovalSubject =>
  ({ kind: fixture.kind, hash: sha256(canonicalJson(fixture.content)), path: fixture.path });

// Puts the subject on the protected branch: its file, or, for a holdout plan, its hash in holdouts.json.
const onProtectedBranch = (subject: SubjectFixture) => (repository: FixtureRepository): void => {
  if (subject.kind === 'holdout-plan') {
    const holdouts = repository.protectedFiles[HOLDOUTS_PATH] as { changeClasses: { changeClassId: string; planHashes: string[] }[] };
    holdouts.changeClasses.push({ changeClassId: 'account-deletion', planHashes: [subjectOf(subject).hash] });
  } else {
    repository.protectedFiles[subject.path] = subject.content;
  }
};

// Also names the owner for the subject's path, and puts the subject's file in pull request 12.
const reviewedInPullRequest = (subject: SubjectFixture) => (repository: FixtureRepository): void => {
  onProtectedBranch(subject)(repository);
  repository.protectedFiles[CODE_OWNERS_PATH] = `${String(repository.protectedFiles[CODE_OWNERS_PATH])}${subject.codeOwnersLine}\n`;
  const pullRequest = repository.pullRequests['12'];
  if (pullRequest === undefined) throw new Error('the team repository has no pull request 12');
  pullRequest.changedFiles.push({ path: subject.path, authors: ['dev-ada'] });
  pullRequest.lastCommitTouching[subject.path] = 'commit-pull-head';
};

async function approvalIn(name: RepositoryName, subject: SubjectFixture): Promise<Approval> {
  let approval: Approval | undefined;
  await withRepository(name, async (repository) => {
    const proof = name === 'solo' ? repository.lockdownProof() : repository.codeOwnerProof('review-grace');
    const verified = await repository.verify(subjectOf(subject), proof);
    if (!verified.ok) throw new Error(`the ${subject.kind} was not approved in the ${name} repository: ${verified.error}`);
    approval = verified.value.approval;
  }, name === 'solo' ? onProtectedBranch(subject) : reviewedInPullRequest(subject));
  if (approval === undefined) throw new Error('no approval');
  return approval;
}

test('there is one subject fixture for each kind other than a plan', { criterion: 'AC-SPEC-02-18' }, () => {
  assert.deepEqual(subjectFixtures().map((fixture) => fixture.kind).sort(), ['extra-review', 'holdout-plan', 'review-decision', 'trusted-file']);
});

for (const subject of subjectFixtures()) {
  test(`the ${subject.kind}'s declared and verified approvals name the same subject and differ only in how they were given`, { criterion: 'AC-SPEC-02-18' }, async () => {
    const declared = await approvalIn('solo', subject);
    const verified = await approvalIn('team', subject);
    assert.deepEqual(declared.subject, verified.subject);
    assert.deepEqual(declared.subject, subjectOf(subject));
    assert.deepEqual([declared.strength, verified.strength], ['declared', 'verified']);
    assert.deepEqual([approvalLabel(declared), approvalLabel(verified)], ['declared, not verified', 'verified']);
  });
}
