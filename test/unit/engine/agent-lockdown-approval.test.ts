// The agent lock-down route, the owner's own: a subject is approved when it reaches the protected
// default branch through a push or merge by the maintainer that protected-branch approvers.json
// names, with the lock-down declared there and the agent's deny-rules file on the protected branch
// denying push, merge and pull-request approval, in Bash or PowerShell. Core cannot see the
// agent's environment, so the approval is always declared, never verified, and labelled
// "declared, not verified". It suffices for every subject, and a project with one person and no
// code-owners file can pass every gate this way.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON_ACTOR_TYPES, approvalLabel, mergeGateOpen, planStanding, unverified, type Approval, type ApprovalErrorCode } from '@revisum/engine';
import {
  APPROVERS_PATH, CODE_OWNERS_PATH, DENY_RULES_PATH, SUBJECT_KINDS, approversOf, assertRefused, denyRulesOf, eventsOfKind,
  loadForChange, memoryApprovalStore, memoryEventSink, parsedSignupPlan, withRepository, withoutDenyRules,
  type FixtureRepository,
} from './approval-repositories.ts';

const MAINTAINER = 'maintainer-mia';

// ---- The maintainer's push or merge -------------------------------------------------------------

test("the maintainer's merge to the protected branch records a declared approval with a person-declared actor", { criterion: 'AC-SPEC-02-14' }, async () => {
  await withRepository('solo', async (repository) => {
    const subject = repository.subject('plan');
    const verified = await repository.verify(subject, repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    const { approval, actor } = verified.value;
    assert.equal(approval.strength, 'declared');
    assert.equal(approval.proofKind, 'agent-lockdown-merge');
    assert.equal(approval.subject.hash, subject.hash);
    assert.equal(actor.actorType, 'person-declared');
    assert.equal(actor.actor, approval.approver);
    assert.ok(!approval.approver.includes(MAINTAINER), 'the approver id holds the raw login');
  });
});

test("the maintainer's merge appends one plan.approved event with proof kind agent-lockdown-merge", { criterion: 'AC-SPEC-02-14' }, async () => {
  await withRepository('solo', async (repository) => {
    const subject = repository.subject('plan');
    const verified = await repository.verify(subject, repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const approved = eventsOfKind(repository.events, 'plan.approved');
    assert.equal(approved.length, 1, JSON.stringify(repository.events.recorded));
    const [recorded] = approved;
    if (recorded === undefined) return;
    assert.equal(recorded.event.subjectHash, subject.hash);
    assert.equal(recorded.event.proofKind, 'agent-lockdown-merge');
    assert.equal(recorded.actor.actorType, 'person-declared');
  });
});

test('the declared approval is dated by when GitHub says the commit landed, not by the run', { criterion: 'AC-SPEC-02-14' }, async () => {
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    const landing = repository.fixture.landings.find((candidate) => candidate.commit === repository.fixture.protectedCommit);
    assert.equal(verified.value.approval.at, landing?.at);
  });
});

const approvesWith = (title: string, edit: (fixture: FixtureRepository) => void): void => {
  test(title, { criterion: 'AC-SPEC-02-14' }, async () => {
    await withRepository('solo', async (repository) => {
      const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
      assert.equal(verified.ok, true, JSON.stringify(verified));
      if (verified.ok) assert.equal(verified.value.approval.strength, 'declared');
    }, edit);
  });
};

approvesWith('the lock-down route also approves when the agent is denied commits as well', (fixture) => {
  approversOf(fixture).agentLockdown?.deniedActions.push('commit');
  denyRulesOf(fixture).permissions.deny.push('Bash(git commit *)', 'PowerShell(git commit *)');
  denyRulesOf(fixture).permissions.allow = [];
});

approvesWith('deny rules written only in their PowerShell form count as denials', withoutDenyRules(/^Bash\(/));

approvesWith('deny rules written only in their Bash form count as denials', withoutDenyRules(/^PowerShell\(/));

approvesWith('a gh pr merge denial alone counts as denying merge', withoutDenyRules(/git (-C \* )?merge/));

// ---- Refusals -----------------------------------------------------------------------------------

type Refusal = {
  readonly title: string;
  readonly code: ApprovalErrorCode;
  readonly edit: (fixture: FixtureRepository) => void;
  readonly proof?: { protectedBranch?: string; commit?: string; mergedBy?: string };
};

const landing = (commit: string, login: string, type: 'user' | 'bot' | 'app') => (fixture: FixtureRepository): void => {
  fixture.landings.push({ commit, branch: 'main', login, type, at: '2026-10-25T09:00:00Z' });
};

const REFUSALS: readonly Refusal[] = [
  {
    title: 'a merge by another user account is refused as not-maintainer',
    code: 'not-maintainer', edit: landing('commit-other-merge', 'agent-account', 'user'),
    proof: { commit: 'commit-other-merge', mergedBy: 'agent-account' },
  },
  {
    title: 'a push by a bot account is refused as not-maintainer',
    code: 'not-maintainer', edit: landing('commit-bot-push', 'github-actions[bot]', 'bot'),
    proof: { commit: 'commit-bot-push', mergedBy: 'github-actions[bot]' },
  },
  {
    title: 'a merge by an app installation token is refused as not-maintainer',
    code: 'not-maintainer', edit: landing('commit-app-merge', 'shop-deployer', 'app'),
    proof: { commit: 'commit-app-merge', mergedBy: 'shop-deployer' },
  },
  {
    title: 'a proof that claims the maintainer merged, when GitHub says another account did, is refused as not-maintainer',
    code: 'not-maintainer', edit: landing('commit-claimed', 'agent-account', 'user'),
    proof: { commit: 'commit-claimed', mergedBy: MAINTAINER },
  },
  {
    // The maintainer pushed it, but only to a branch of their own.
    title: 'a subject only on another branch is refused as not-protected-branch',
    code: 'not-protected-branch', edit: () => {},
    proof: { protectedBranch: 'maintainer/draft', commit: 'commit-maintainer-draft', mergedBy: MAINTAINER },
  },
  {
    title: 'a proof naming the protected branch for a commit that never landed there is refused as not-protected-branch',
    code: 'not-protected-branch', edit: () => {},
    proof: { commit: 'commit-maintainer-draft' },
  },
  {
    title: 'with no lock-down declared in approvers.json, the route is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: (fixture) => { delete approversOf(fixture).agentLockdown; },
  },
  {
    title: 'with no approvers.json on the protected branch, the route is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: (fixture) => { delete fixture.protectedFiles[APPROVERS_PATH]; },
  },
  {
    title: 'with the deny-rules file absent from the protected branch, the route is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: (fixture) => { delete fixture.protectedFiles[DENY_RULES_PATH]; },
  },
  {
    title: 'a deny-rules file with no push denial is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: withoutDenyRules(/push/),
  },
  {
    title: 'a deny-rules file with neither a git merge nor a gh pr merge denial is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: withoutDenyRules(/merge/),
  },
  {
    title: 'a deny-rules file with no pull-request approval denial is refused as lockdown-not-declared',
    code: 'lockdown-not-declared', edit: withoutDenyRules(/pr review/),
  },
  {
    title: 'a lock-down whose denied actions leave out merge is refused as lockdown-not-declared',
    code: 'lockdown-not-declared',
    edit: (fixture) => {
      const lockdown = approversOf(fixture).agentLockdown;
      if (lockdown !== undefined) lockdown.deniedActions = lockdown.deniedActions.filter((action) => action !== 'merge');
    },
  },
  {
    title: 'a deny-rules file edited only in the change does not count: the protected version lacks the push denial',
    code: 'lockdown-not-declared',
    edit: (fixture) => {
      fixture.workingCopy[DENY_RULES_PATH] = structuredClone(denyRulesOf(fixture));
      withoutDenyRules(/push/)(fixture);
    },
  },
];

for (const refusal of REFUSALS) {
  test(refusal.title, { criterion: 'AC-SPEC-02-15' }, async () => {
    await withRepository('solo', async (repository) => {
      assertRefused(repository, await repository.verify(repository.subject('plan'), repository.lockdownProof(refusal.proof)), refusal.code);
    }, refusal.edit);
  });
}

test('the unedited solo repository, which every refusal above changes in one way, approves', { criterion: 'AC-SPEC-02-15' }, async () => {
  // The counter-example: each refusal differs from this case by its one edit or proof field.
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
  });
});

// ---- GitHub unavailable -------------------------------------------------------------------------

for (const down of [['landedBy'], ['protectedFile'], ['reviews', 'changedFiles', 'pullRequest', 'lastCommitTouching', 'protectedFile', 'landedBy']] as const) {
  test(`when GitHub cannot answer ${down.join(', ')}, a lock-down approval is absent with version-control-unavailable`, { criterion: 'AC-SPEC-02-13' }, async () => {
    await withRepository('solo', async (repository) => {
      assertRefused(repository, await repository.verify(repository.subject('plan'), repository.lockdownProof(), down), 'version-control-unavailable');
    });
  });
}

// ---- Declared, not verified ---------------------------------------------------------------------

test('a lock-down approval is labelled "declared, not verified", whatever the maintainer declares about credentials', { criterion: 'AC-SPEC-02-16' }, async () => {
  for (const agentHasGithubCredentials of [true, false]) {
    await withRepository('solo', async (repository) => {
      const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
      assert.equal(verified.ok, true, JSON.stringify(verified));
      if (!verified.ok) return;
      assert.equal(verified.value.approval.strength, 'declared');
      assert.equal(approvalLabel(verified.value.approval), 'declared, not verified');
    }, (fixture) => {
      const lockdown = approversOf(fixture).agentLockdown;
      if (lockdown !== undefined) lockdown.agentHasGithubCredentials = agentHasGithubCredentials;
    });
  }
});

test('the same plan approved by a code owner is labelled verified, so the label follows the route', { criterion: 'AC-SPEC-02-16' }, async () => {
  await withRepository('team', async (repository) => {
    const subject = repository.subject('plan');
    const reviewed = await repository.verify(subject, repository.codeOwnerProof('review-grace'));
    const merged = await repository.verify(subject, repository.lockdownProof());
    assert.equal(reviewed.ok && merged.ok, true, JSON.stringify({ reviewed, merged }));
    if (!reviewed.ok || !merged.ok) return;
    assert.deepEqual([approvalLabel(reviewed.value.approval), approvalLabel(merged.value.approval)], ['verified', 'declared, not verified']);
  });
});

// ---- Every subject kind, on the declared route alone ---------------------------------------------

for (const kind of SUBJECT_KINDS) {
  test(`a ${kind} with only the maintainer's declared approval is approved as a person's approval`, { criterion: 'AC-SPEC-02-18' }, async () => {
    await withRepository('solo', async (repository) => {
      const subject = repository.subject(kind);
      const verified = await repository.verify(subject, repository.lockdownProof());
      assert.equal(verified.ok, true, JSON.stringify(verified));
      if (!verified.ok) return;
      assert.deepEqual({ kind: verified.value.approval.subject.kind, hash: verified.value.approval.subject.hash }, { kind, hash: subject.hash });
      assert.equal(verified.value.approval.strength, 'declared');
      assert.equal(PERSON_ACTOR_TYPES.includes(verified.value.actor.actorType), true, 'a declared approval did not count as a person');
    });
  });
}

// ---- One person, no code-owners file, no second account -------------------------------------------

test('with one person, no code-owners file and no second account, every subject kind passes through the lock-down route', { criterion: 'AC-SPEC-02-19' }, async () => {
  await withRepository('solo', async (repository) => {
    // The solo fixture: no code-owners file, and only the maintainer lands commits on the protected branch.
    assert.equal(repository.fixture.protectedFiles[CODE_OWNERS_PATH], undefined);
    const accounts = new Set(repository.fixture.landings.filter((entry) => entry.branch === repository.fixture.protectedBranch).map((entry) => entry.login));
    assert.deepEqual([...accounts], [MAINTAINER]);
    const outcomes: Record<string, unknown> = {};
    for (const kind of SUBJECT_KINDS) {
      const verified = await repository.verify(repository.subject(kind), repository.lockdownProof());
      outcomes[kind] = verified.ok ? verified.value.approval.strength : verified.error;
    }
    assert.deepEqual(outcomes, Object.fromEntries(SUBJECT_KINDS.map((kind) => [kind, 'declared'])));
  });
});

test("in the solo repository the plan gate opens on the maintainer's declared approval", { criterion: 'AC-SPEC-02-19' }, async () => {
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    assert.equal(mergeGateOpen(planStanding(parsedSignupPlan(), memoryApprovalStore([verified.value.approval]))), true);
  });
});

// Words that would ask for a second approver. Every text the SPEC-02 surface produces for the solo
// repository is searched for them.
const SECOND_APPROVER_WORDS = [/\bsecond\b/, /\banother approver\b/, /\bother approver\b/, /\bcode[- ]owners?\b/, /\breviewers?\b/, /\btwo[- ]person\b/, /\btwo people\b/];

test('nothing the trust and approval surface produces for the solo repository mentions a second approver', { criterion: 'AC-SPEC-02-19' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaderEvents = memoryEventSink();
    const texts: unknown[] = [];
    texts.push(await loadForChange(repository.versionControl(), ['project.json', 'src/checkout.ts'], loaderEvents));
    const approvals: Approval[] = [];
    for (const kind of SUBJECT_KINDS) {
      const verified = await repository.verify(repository.subject(kind), repository.lockdownProof());
      texts.push(verified);
      if (verified.ok) {
        approvals.push(verified.value.approval);
        texts.push(approvalLabel(verified.value.approval));
      }
    }
    // A refused attempt, an unapproved plan and an unverified local decision say why, too.
    texts.push(await repository.verify(repository.subject('plan'), repository.lockdownProof({ commit: 'commit-maintainer-draft' })));
    texts.push(planStanding(parsedSignupPlan(), memoryApprovalStore([])));
    texts.push(planStanding(parsedSignupPlan(), memoryApprovalStore(approvals)));
    texts.push(unverified(repository.subject('plan'), 'local'));
    texts.push(repository.events.recorded, loaderEvents.recorded);
    const produced = JSON.stringify(texts).toLowerCase();
    for (const word of SECOND_APPROVER_WORDS) assert.ok(!word.test(produced), `the solo repository's output matches ${word}: ${produced}`);
  });
});
