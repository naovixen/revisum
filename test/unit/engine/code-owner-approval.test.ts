// The optional code-owner route: an approving review fetched from GitHub verifies only when the
// reviewer is a user account, is named for the subject's path in the protected-branch code-owners
// file, is neither the change's author nor the author of a commit in it that touches the subject,
// and reviewed the last commit that touched the subject. A verified review appends a plan.approved
// event against a pseudonymous approver, dated by GitHub, never by the run's clock.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON_ACTOR_TYPES } from '@revisum/engine';
import { CODE_OWNERS_PATH, assertRefused, eventsOfKind, withRepository, type FixtureRepository } from './approval-repositories.ts';

const PLAN_OWNER = 'owner-grace';

// Names `owners` as the plans' code owners on the protected branch (the last matching line wins).
const plansOwnedBy = (...owners: string[]) => (fixture: FixtureRepository): void => {
  fixture.protectedFiles[CODE_OWNERS_PATH] = `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/plans/ ${owners.map((owner) => `@${owner}`).join(' ')}\n`;
};

const reviewSubmittedAt = (fixture: FixtureRepository, reviewId: string): string | undefined =>
  fixture.pullRequests['12']?.reviews.find((review) => review.id === reviewId)?.submittedAt;

// ---- A review that verifies ---------------------------------------------------------------------

test('a current review by a code owner verifies as a verified approval with a person-verified actor', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = repository.subject('plan');
    const verified = await repository.verify(subject, repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    const { approval, actor } = verified.value;
    assert.equal(approval.strength, 'verified');
    assert.equal(approval.proofKind, 'code-owner-review');
    assert.deepEqual({ kind: approval.subject.kind, hash: approval.subject.hash }, { kind: 'plan', hash: subject.hash });
    assert.equal(actor.actorType, 'person-verified');
    assert.equal(actor.actor, approval.approver);
  });
});

test('a verified review appends one plan.approved event with the subject hash, pseudonymous approver, actor type and proof kind', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = repository.subject('plan');
    const verified = await repository.verify(subject, repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    const approved = eventsOfKind(repository.events, 'plan.approved');
    assert.equal(approved.length, 1, JSON.stringify(repository.events.recorded));
    const [recorded] = approved;
    if (recorded === undefined) return;
    assert.equal(recorded.event.subjectHash, subject.hash);
    assert.equal(recorded.event.proofKind, 'code-owner-review');
    assert.equal(recorded.actor.actor, verified.value.approval.approver);
    assert.equal(recorded.actor.actorType, 'person-verified');
  });
});

test('the approver on the approval and its event is pseudonymous, never the login of the reviewer', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    assert.ok(!verified.value.approval.approver.includes(PLAN_OWNER), 'the approver id holds the raw login');
    assert.ok(!JSON.stringify(repository.events.recorded).includes(PLAN_OWNER), 'an event holds the raw login');
  });
});

test('the approval is dated by the review GitHub submitted, not by the run', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    assert.equal(verified.value.approval.at, reviewSubmittedAt(repository.fixture, 'review-grace'));
  });
});

// ---- Self-approval ------------------------------------------------------------------------------

test('a code owner who wrote a commit in the change that touches the subject cannot approve it: self-approval', { criterion: 'AC-SPEC-02-06' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace')), 'self-approval');
  }, (fixture) => {
    // The same review that verifies above, except that owner-grace also wrote part of the plan.
    fixture.pullRequests['12']?.changedFiles.find((file) => file.path === 'plans/signup.json')?.authors.push(PLAN_OWNER);
  });
});

test('a code owner who opened the change cannot approve it, though she wrote no commit in it: self-approval', { criterion: 'AC-SPEC-02-06' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace')), 'self-approval');
  }, (fixture) => {
    const pullRequest = fixture.pullRequests['12'];
    if (pullRequest !== undefined) pullRequest.author = PLAN_OWNER;
  });
});

test('a reviewer who wrote the subject and is also its only code owner still gets self-approval', { criterion: 'AC-SPEC-02-06' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-ada')), 'self-approval');
  }, (fixture) => {
    plansOwnedBy('dev-ada')(fixture);
    fixture.pullRequests['12']?.reviews.push({
      id: 'review-ada', state: 'approved', commit: 'commit-pull-head', submittedAt: '2026-10-20T15:30:00Z',
      reviewer: { login: 'dev-ada', type: 'user' },
    });
  });
});

// ---- Bots and apps ------------------------------------------------------------------------------

for (const [reviewId, accountType] of [['review-helper-bot', 'bot'], ['review-ci-app', 'app']] as const) {
  test(`an approving review from a ${accountType} account named as code owner does not verify, and is recorded as an agent`, { criterion: 'AC-SPEC-02-07' }, async () => {
    await withRepository('team', async (repository) => {
      assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof(reviewId)), 'bot-or-app');
      const refused = eventsOfKind(repository.events, 'approval.refused');
      for (const { actor } of refused) {
        assert.equal(actor.actorType, 'agent');
        assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false);
      }
    }, plansOwnedBy(PLAN_OWNER, 'review-helper[bot]', 'shop-ci'));
  });
}

// ---- Code owners --------------------------------------------------------------------------------

test('a reviewer the protected-branch code-owners file names only for another path gets not-code-owner', { criterion: 'AC-SPEC-02-08' }, async () => {
  await withRepository('team', async (repository) => {
    // reviewer-linus owns /docs/ only; the subject is plans/signup.json.
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-linus')), 'not-code-owner');
  });
});

test('with no code-owners file on the protected branch, no reviewer is a code owner', { criterion: 'AC-SPEC-02-08' }, async () => {
  await withRepository('team', async (repository) => {
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace')), 'not-code-owner');
  }, (fixture) => { delete fixture.protectedFiles[CODE_OWNERS_PATH]; });
});

test('a reviewer named for the path of the subject passes the code-owner check', { criterion: 'AC-SPEC-02-08' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = { kind: 'trusted-file' as const, hash: repository.subject('plan').hash, path: 'docs/guide.md' };
    // reviewer-linus owns /docs/, so for a docs subject the code-owner check passes.
    const verified = await repository.verify(subject, repository.codeOwnerProof('review-linus'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    fixture.protectedFiles['docs/guide.md'] = fixture.protectedFiles['plans/signup.json'];
    const pullRequest = fixture.pullRequests['12'];
    pullRequest?.changedFiles.push({ path: 'docs/guide.md', authors: ['dev-ada'] });
    if (pullRequest !== undefined) pullRequest.lastCommitTouching['docs/guide.md'] = 'commit-pull-head';
  });
});

// ---- Stale reviews ------------------------------------------------------------------------------

test('a review on a commit older than the last commit touching the subject gets stale-commit', { criterion: 'AC-SPEC-02-09' }, async () => {
  await withRepository('team', async (repository) => {
    // owner-grace approved commit-pull-first; the subject last changed in commit-pull-head.
    assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace-early')), 'stale-commit');
  });
});

test('a proof that names the old commit does not make a stale review current', { criterion: 'AC-SPEC-02-09' }, async () => {
  // What counts is GitHub's last commit touching the subject, not the commit the proof claims.
  await withRepository('team', async (repository) => {
    const proof = repository.codeOwnerProof('review-grace-early', { commit: 'commit-pull-first' });
    assertRefused(repository, await repository.verify(repository.subject('plan'), proof), 'stale-commit');
  });
});

test('once the subject last changed in the reviewed commit, the same review is not stale', { criterion: 'AC-SPEC-02-09' }, async () => {
  // The counter-example: only the last commit touching the subject differs from the stale case.
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace-early'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    const pullRequest = fixture.pullRequests['12'];
    if (pullRequest !== undefined) pullRequest.lastCommitTouching['plans/signup.json'] = 'commit-pull-first';
  });
});

// ---- GitHub unavailable -------------------------------------------------------------------------

const DOWN = [['reviews'], ['changedFiles'], ['pullRequest'], ['lastCommitTouching'], ['protectedFile'],
  ['reviews', 'changedFiles', 'pullRequest', 'lastCommitTouching', 'protectedFile', 'landedBy']] as const;

for (const down of DOWN) {
  test(`when GitHub cannot answer ${down.join(', ')}, a code-owner review is absent with version-control-unavailable`, { criterion: 'AC-SPEC-02-13' }, async () => {
    await withRepository('team', async (repository) => {
      const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'), down);
      assertRefused(repository, verified, 'version-control-unavailable');
    });
  });
}
