// Who did what: actors and the audit events recorded against them. The actor on every event is
// derived by core from the approval proof, never declared by the caller, so an agent cannot
// label its own work as a person's.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import type { ApprovalErrorCode, ApprovalProof } from './approval.ts';
import type { Brand } from './brand.ts';
import type { Result } from './result.ts';

// A keyed hash (HMAC) of the identity under the customer's key: pseudonymous, never the raw identity.
export type ActorId = Brand<string, 'ActorId'>;

// Set by core from the approval proof, never by the caller. A declared person rests on the
// founder's own push or merge (the agent lock-down route); a verified person on a checked account.
export type ActorType = 'person-verified' | 'person-declared' | 'agent' | 'ci' | 'unverified';

// The actor types that count as a person. Both gate and count alike; only the label differs.
// Nothing requires a second person. Every gate, metric and level tests membership of this list
// rather than comparing with one person type, so a declared approval is never left out.
export const PERSON_ACTOR_TYPES: readonly ActorType[] = Object.freeze(['person-verified', 'person-declared']);

// Only the approval verifier and core's runtime build this, so a caller cannot choose its own actor
// type. Code that records an event receives one and passes it on.
export type DerivedActor = Brand<{ readonly actor: ActorId; readonly actorType: ActorType }, 'DerivedActor'>;

export type AuditEventKind =
  | 'plan.submitted' | 'plan.rejected' | 'plan.denied' | 'plan.approved' | 'approval.refused'
  | 'trusted.changed-with-code' | 'run.finished' | 'review.decided' | 'severity.overridden' | 'adapter.admitted'
  | 'pack.admitted' | 'check.removed' | 'tracker.changed' | 'holdout.access-refused';

// What a caller records. The actor is passed separately, as a DerivedActor. The plan authoring
// route (which tool produced a draft) joins this when plan authoring is built (SPEC-28).
export type EventInput = {
  readonly kind: AuditEventKind;
  readonly subjectHash?: string;
  readonly runId?: string;
  readonly criterionIds?: readonly string[];
  // On plan.approved and approval.refused: the route the approval was offered by.
  readonly proofKind?: ApprovalProof['kind'];
  // On approval.refused: why the approval verifier refused it.
  readonly code?: ApprovalErrorCode;
  // On trusted.changed-with-code: the trusted file the change edited, relative to the repository root.
  readonly path?: string;
};

// not-append-only: the file no longer holds exactly what the sink wrote, so something else
// truncated or rewrote it. write-failed: the file system refused the write.
export type SinkError = { readonly code: 'not-append-only' | 'write-failed' };

// The audit sink: append-only, one entry per event. The audit log later wraps it with a hash
// chain and an anchor (SPEC-14). A run's step log (RunEventSink in engine) is separate.
export interface EventSink {
  append(event: EventInput, actor: DerivedActor): Result<{ readonly sequence: number }, SinkError>;
}
