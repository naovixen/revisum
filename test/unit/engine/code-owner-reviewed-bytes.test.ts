// A code-owner review approves the bytes the reviewer saw: the file at the subject's path in the
// reviewed commit, which must be the pull request's last commit touching that path. So:
//   - a review verifies before the pull request merges, while the protected branch still holds
//     the old plan, when the reviewed commit holds the plan's bytes;
//   - a commit after the review that changes the plan makes the review stale, for the bytes the
//     reviewer saw as much as for the new ones;
//   - a hash the reviewed commit does not hold is refused with subject-mismatch, even when it is
//     the plan on the protected branch.
// The version-control port reads a file at a commit through fileAtCommit(path, commit).
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHash, type ApprovalSubject } from '@revisum/engine';
import {
  PLAN_PATH, assertRefused, eventsOfKind, parsedSignupPlan, withRepository, type FixtureRepository,
} from './approval-repositories.ts';
import { signupPlan, withValue } from './plan-examples.ts';

// Pull request 12 in the team repository: owner-grace's review-grace is on commit-pull-head, the
// last commit touching the plan, and review-grace-early is on the older commit-pull-first.
const PULL_REQUEST = '12';
const HEAD_COMMIT = 'commit-pull-head';
const FIRST_COMMIT = 'commit-pull-first';

// The sign-up plan as the pull request changes it, and as a later commit changes it again.
const retitledPlan = (title: string) => parsedSignupPlan(withValue(signupPlan(), ['meta', 'title'], title));
const REVIEWED_PLAN = retitledPlan('Sign-up with a newsletter opt-in');
const LATER_PLAN = retitledPlan('Sign-up with a newsletter opt-out');
const NEVER_COMMITTED_PLAN = retitledPlan('Sign-up nobody committed');

const planSubject = (plan: ReturnType<typeof parsedSignupPlan>): ApprovalSubject => ({ kind: 'plan', hash: planHash(plan), path: PLAN_PATH });

// Gives `commit` its own version of the plan; the protected branch keeps the old one.
const planAtCommit = (commit: string, plan: ReturnType<typeof parsedSignupPlan>) => (fixture: FixtureRepository): void => {
  fixture.filesAtCommits = { ...fixture.filesAtCommits, [commit]: { ...fixture.filesAtCommits?.[commit], [PLAN_PATH]: plan } };
};

// ---- (a) The reviewed commit holds the plan: it verifies before merge ---------------------------

test('a code owner\'s review of the commit holding the plan verifies before the pull request merges', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = planSubject(REVIEWED_PLAN);
    assert.notEqual(subject.hash, repository.subject('plan').hash, 'the protected branch already holds the reviewed plan');
    const verified = await repository.verify(subject, repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    assert.equal(verified.value.approval.strength, 'verified');
    assert.equal(verified.value.approval.proofKind, 'code-owner-review');
    assert.deepEqual({ kind: verified.value.approval.subject.kind, hash: verified.value.approval.subject.hash }, { kind: 'plan', hash: subject.hash });
    assert.equal(verified.value.actor.actorType, 'person-verified');
  }, planAtCommit(HEAD_COMMIT, REVIEWED_PLAN));
});

test('the review that verifies before merge appends one plan.approved event for the reviewed plan\'s hash', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = planSubject(REVIEWED_PLAN);
    const verified = await repository.verify(subject, repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const approved = eventsOfKind(repository.events, 'plan.approved');
    assert.equal(approved.length, 1, JSON.stringify(repository.events.recorded));
    const [recorded] = approved;
    if (recorded === undefined) return;
    assert.equal(recorded.event.subjectHash, subject.hash);
    assert.equal(recorded.event.proofKind, 'code-owner-review');
    assert.equal(recorded.actor.actorType, 'person-verified');
  }, planAtCommit(HEAD_COMMIT, REVIEWED_PLAN));
});

// ---- (b) A commit after the review changed the plan: refused ------------------------------------

// owner-grace reviewed commit-pull-first, which held REVIEWED_PLAN; commit-pull-head then changed
// the plan to LATER_PLAN and is the last commit touching it.
const changedAfterReview = (fixture: FixtureRepository): void => {
  planAtCommit(FIRST_COMMIT, REVIEWED_PLAN)(fixture);
  planAtCommit(HEAD_COMMIT, LATER_PLAN)(fixture);
  assert.equal(fixture.pullRequests[PULL_REQUEST]?.lastCommitTouching[PLAN_PATH], HEAD_COMMIT);
};

test('a review is refused for the plan a later commit wrote, which the reviewer never saw', { criterion: 'AC-SPEC-02-04' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(planSubject(LATER_PLAN), repository.codeOwnerProof('review-grace-early')), 'stale-commit');
  }, changedAfterReview);
});

test('a review is refused even for the bytes the reviewer saw, once a later commit in the pull request changed the plan', { criterion: 'AC-SPEC-02-04' }, async () => {
  await withRepository('team', async (repository) => {
    const proof = repository.codeOwnerProof('review-grace-early', { commit: FIRST_COMMIT });
    assertRefused(repository, await repository.verify(planSubject(REVIEWED_PLAN), proof), 'stale-commit');
  }, changedAfterReview);
});

test('counter-example: with no later change, the same review of the same bytes verifies before merge', { criterion: 'AC-SPEC-02-04' }, async () => {
  // Only the commits differ from the refusals above: the reviewed commit is the last to touch the plan.
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(planSubject(REVIEWED_PLAN), repository.codeOwnerProof('review-grace-early', { commit: FIRST_COMMIT }));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    planAtCommit(FIRST_COMMIT, REVIEWED_PLAN)(fixture);
    const pullRequest = fixture.pullRequests[PULL_REQUEST];
    if (pullRequest !== undefined) pullRequest.lastCommitTouching[PLAN_PATH] = FIRST_COMMIT;
  });
});

// ---- (c) A hash the reviewed commit does not hold: subject-mismatch -----------------------------

test('a review is refused with subject-mismatch for a plan hash no reviewed commit holds', { criterion: 'AC-SPEC-02-04' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(planSubject(NEVER_COMMITTED_PLAN), repository.codeOwnerProof('review-grace')), 'subject-mismatch');
  }, planAtCommit(HEAD_COMMIT, REVIEWED_PLAN));
});

test('a review is refused with subject-mismatch for the protected branch\'s plan when the reviewed commit holds another', { criterion: 'AC-SPEC-02-04' }, async () => {
  // The protected branch's plan was not what owner-grace reviewed: the pull request replaces it.
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace')), 'subject-mismatch');
  }, planAtCommit(HEAD_COMMIT, REVIEWED_PLAN));
});
