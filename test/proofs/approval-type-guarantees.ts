// Compile-time guarantees around approvals. Type-checked by approval-type-guarantees.test.ts and
// by type-check.test.ts, never run.
//   - An Approval comes only from the approval verifier: an object literal is not one, and the
//     actor that unverified() returns for a local, MCP or token decision is not one either. Every
//     gate, metric and level takes an Approval, so such a decision can never reach one.
//   - A declared approval and a verified approval are both an Approval, so wherever a gate takes
//     an Approval, the owner's declared approval passes exactly as a verified one does.
// Each @ts-expect-error line must stay an error; the test deletes them to prove it.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import {
  unverified,
  type ActorId, type Approval, type ApprovalSubject, type DeclaredApproval, type DerivedActor, type VerifiedApproval,
} from '@revisum/engine';

const subject: ApprovalSubject = { kind: 'plan', hash: 'plan-hash' };

// A gate as later specs write it: it takes an Approval, never a VerifiedApproval.
const opensGate = (approval: Approval): boolean => approval.subject.hash.length > 0;

// ---- What a decision without a usable proof yields ----------------------------------------------
export const localDecision: DerivedActor = unverified(subject, 'local');
export const mcpDecision: DerivedActor = unverified(subject, 'mcp');
export const tokenDecision: DerivedActor = unverified(subject, 'token');

// @ts-expect-error the actor for a local decision is not an Approval, so it cannot open a gate
export const localDecisionAtGate = opensGate(unverified(subject, 'local'));

// @ts-expect-error the actor for an MCP decision is not an Approval, so it cannot open a gate
export const mcpDecisionAtGate = opensGate(unverified(subject, 'mcp'));

export const forgedApproval = (approver: ActorId): boolean => opensGate(
  // @ts-expect-error an object literal is not an Approval: only the approval verifier mints one
  { subject, approver, proofKind: 'agent-lockdown-merge', strength: 'declared', at: '2026-10-28T09:00:00Z' },
);

// @ts-expect-error unverified() takes only a local, MCP or token source, never a person
export const personSource = unverified(subject, 'person');

// ---- Declared and verified pass the same gate ---------------------------------------------------
export const declaredAtGate = (approval: DeclaredApproval): boolean => opensGate(approval);
export const verifiedAtGate = (approval: VerifiedApproval): boolean => opensGate(approval);
