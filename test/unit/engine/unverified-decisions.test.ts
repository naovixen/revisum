// A decision with no usable proof is never a person's approval. A local decision is recorded as
// 'unverified'; one that arrives through an MCP session or a CI token as 'agent'. Neither mints an
// Approval, so neither can gate a merge, and neither counts as a human touch toward
// verifiedWithoutReviewShare, planApprovalsPerChange or unreviewedMergeShare.
//
// SPEC-02 gives no function that records such a decision: unverified() only derives the actor.
// The event tests below therefore make the call a recorder is expected to make, appending the
// decision against the actor unverified() derived, and check what the audit sink holds.
// The metric is built by the review recorder (docs/specs/SPEC-13-review-queue-and-recorder.md)
// and is tested with it.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERSON_ACTOR_TYPES, approvalFor, mergeGateOpen, planHash, planStanding, unverified,
  type ApprovalSubject,
} from '@revisum/engine';
import { eventsOfKind, memoryApprovalStore, memoryEventSink, parsedSignupPlan, withRepository } from './approval-repositories.ts';

const SOURCES = ['local', 'mcp', 'token'] as const;
const planSubject = (): ApprovalSubject => ({ kind: 'plan', hash: planHash(parsedSignupPlan()) });

// ---- No Approval is minted ------------------------------------------------------------------------

test('a decision with no proof gives only an actor and its type, never an approval or a strength', { criterion: 'AC-SPEC-02-11' }, () => {
  for (const source of SOURCES) {
    const actor = unverified(planSubject(), source);
    assert.deepEqual(Object.keys(actor).sort(), ['actor', 'actorType'], `the ${source} decision carries more than an actor`);
  }
});

test('decisions with no proof from every source leave the plan with no approval and the merge gate shut', { criterion: 'AC-SPEC-02-11' }, () => {
  const plan = parsedSignupPlan();
  const actorTypes = SOURCES.map((source) => unverified({ kind: 'plan', hash: planHash(plan), path: 'plans/signup.json' }, source).actorType);
  assert.deepEqual(actorTypes, ['unverified', 'agent', 'agent']);
  assert.equal(actorTypes.some((actorType) => PERSON_ACTOR_TYPES.includes(actorType)), false);
  const store = memoryApprovalStore([]);
  assert.equal(approvalFor(plan, store), null);
  assert.equal(mergeGateOpen(planStanding(plan, store)), false);
});

test("the maintainer's declared approval of the same plan does open the merge gate", { criterion: 'AC-SPEC-02-11' }, async () => {
  // The counter-example: a proof the verifier accepts mints the approval the decisions above lack.
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    assert.equal(mergeGateOpen(planStanding(parsedSignupPlan(), memoryApprovalStore([verified.value.approval]))), true);
  });
});

// ---- The recorded event carries the derived actor --------------------------------------------------

for (const source of ['mcp', 'token'] as const) {
  test(`a decision recorded from ${source === 'mcp' ? 'an MCP session' : 'a CI token'} is appended with actor type agent and approves nothing`, { criterion: 'AC-SPEC-02-07' }, () => {
    const events = memoryEventSink();
    const subject = planSubject();
    events.append({ kind: 'review.decided', subjectHash: subject.hash }, unverified(subject, source));
    const decided = eventsOfKind(events, 'review.decided');
    assert.equal(decided.length, 1);
    assert.equal(decided[0]?.actor.actorType, 'agent');
    assert.equal(eventsOfKind(events, 'plan.approved').length, 0);
  });
}

test('a local decision with no proof is appended with actor type unverified', { criterion: 'AC-SPEC-02-11' }, () => {
  const events = memoryEventSink();
  events.append({ kind: 'review.decided', subjectHash: planSubject().hash }, unverified(planSubject(), 'local'));
  assert.equal(eventsOfKind(events, 'review.decided')[0]?.actor.actorType, 'unverified');
});

test('a decision from an MCP session or a CI token is an agent decision for every subject kind', { criterion: 'AC-SPEC-02-17' }, () => {
  const kinds: readonly ApprovalSubject['kind'][] = ['plan', 'trusted-file', 'review-decision', 'extra-review', 'holdout-plan'];
  for (const kind of kinds) {
    for (const source of ['mcp', 'token'] as const) {
      assert.equal(unverified({ kind, hash: 'a'.repeat(64) }, source).actorType, 'agent', `${kind} from ${source}`);
    }
  }
});

// ---- The metric does not count them as human touches -----------------------------------------------
