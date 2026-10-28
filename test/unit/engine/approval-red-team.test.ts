// The red-team fixture repository: a project whose own trusted files name the coding agent's
// accounts as maintainer and code owner, offering approvals from a bot, an app and a CI token by
// every route. None of them may ever gate a merge, whatever the project declares: no approval is
// minted, no plan.approved event is appended, and the merge gate stays shut.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERSON_ACTOR_TYPES, approvalFor, mergeGateOpen, planStanding, unverified, type Approval, type ApprovalErrorCode, type ApprovalProof,
} from '@revisum/engine';
import {
  APPROVERS_PATH, approversOf, assertRefused, memoryApprovalStore, parsedSignupPlan, withRepository,
  type FixtureRepository, type TestRepository,
} from './approval-repositories.ts';

type Attempt = {
  readonly title: string;
  readonly proof: (repository: TestRepository) => ApprovalProof;
  readonly code: ApprovalErrorCode;
  readonly edit?: (fixture: FixtureRepository) => void;
};

const ATTEMPTS: readonly Attempt[] = [
  {
    title: 'the agent bot, named as maintainer, merging to the protected branch',
    proof: (repository) => repository.lockdownProof({ commit: 'commit-main-head', mergedBy: 'revisum-agent[bot]' }),
    code: 'not-maintainer',
  },
  {
    title: 'the agent app, named as maintainer, merging to the protected branch',
    proof: (repository) => repository.lockdownProof({ commit: 'commit-app-merge', mergedBy: 'revisum-agent' }),
    code: 'not-maintainer',
    edit: (fixture) => {
      const lockdown = approversOf(fixture).agentLockdown;
      if (lockdown !== undefined) lockdown.maintainer = 'revisum-agent';
    },
  },
  {
    title: 'a CI token, named as maintainer, pushing to the protected branch',
    proof: (repository) => repository.lockdownProof({ commit: 'commit-token-push', mergedBy: 'github-actions[bot]' }),
    code: 'not-maintainer',
    edit: (fixture) => {
      const lockdown = approversOf(fixture).agentLockdown;
      if (lockdown !== undefined) lockdown.maintainer = 'github-actions[bot]';
    },
  },
  {
    title: 'the agent bot, named as code owner, approving the pull request',
    proof: (repository) => repository.codeOwnerProof('review-agent-bot'),
    code: 'bot-or-app',
  },
  {
    title: 'the agent app, named as code owner, approving the pull request',
    proof: (repository) => repository.codeOwnerProof('review-agent-app'),
    code: 'bot-or-app',
  },
  {
    title: 'a CI token, named as code owner, approving the pull request',
    proof: (repository) => repository.codeOwnerProof('review-ci-token'),
    code: 'bot-or-app',
  },
];

for (const attempt of ATTEMPTS) {
  test(`no approval gates when it comes from ${attempt.title}`, { criterion: 'AC-SPEC-02-17' }, async () => {
    await withRepository('red-team', async (repository) => {
      const subject = repository.subject('plan');
      const verified = await repository.verify(subject, attempt.proof(repository));
      assertRefused(repository, verified, attempt.code);
      for (const { actor } of repository.events.recorded) {
        assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false, `an agent approval was recorded as ${actor.actorType}`);
      }
    }, attempt.edit);
  });
}

test('after every agent attempt in the red-team repository, the merge gate is still shut', { criterion: 'AC-SPEC-02-17' }, async () => {
  const minted: Approval[] = [];
  for (const attempt of ATTEMPTS) {
    await withRepository('red-team', async (repository) => {
      const verified = await repository.verify(repository.subject('plan'), attempt.proof(repository));
      if (verified.ok) minted.push(verified.value.approval);
    }, attempt.edit);
  }
  assert.deepEqual(minted, []);
  assert.equal(approvalFor(parsedSignupPlan(), memoryApprovalStore(minted)), null);
  assert.equal(mergeGateOpen(planStanding(parsedSignupPlan(), memoryApprovalStore(minted))), false);
});

test('decisions offered through an MCP session or a CI token are agents, whatever the project declares', { criterion: 'AC-SPEC-02-17' }, async () => {
  await withRepository('red-team', async (repository) => {
    for (const source of ['mcp', 'token'] as const) {
      assert.equal(unverified(repository.subject('plan'), source).actorType, 'agent');
    }
  });
});

test('the same lock-down, with a person as maintainer who merged, does approve', { criterion: 'AC-SPEC-02-17' }, async () => {
  // The counter-example: change only the account that landed the commit, to a user named as
  // maintainer, and the route approves. So the refusals above come from the bot, app or token.
  await withRepository('red-team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof({ commit: 'commit-person-merge', mergedBy: 'maintainer-mia' }));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    const lockdown = approversOf(fixture).agentLockdown;
    if (lockdown !== undefined) lockdown.maintainer = 'maintainer-mia';
    fixture.landings.push({ commit: 'commit-person-merge', branch: 'main', login: 'maintainer-mia', type: 'user', at: '2026-10-25T09:00:00Z' });
    if (fixture.protectedFiles[APPROVERS_PATH] === undefined) throw new Error('the red-team repository has no approvers.json');
  });
});
