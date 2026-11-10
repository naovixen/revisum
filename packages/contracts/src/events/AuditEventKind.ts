// Who did what: actors and the audit events recorded against them. The actor on every event is
// derived by core from the approval proof, never declared by the caller, so an agent cannot
// label its own work as a person's.
import type { ApprovalErrorCode, ApprovalProof } from "../ports/Approval.ts";
import type { ActorId } from "./ActorId.ts";
import type { Brand } from "../foundation/Brand.ts";
import type { PlanProvenance } from "../plan/PlanDraft.ts";
import type { PolicyRuleId } from "../ports/PolicyRuleId.ts";
import type { Result } from "../foundation/Result.ts";

// Set by core from the approval proof, never by the caller. A declared person rests on the
// founder's own push or merge (the agent lock-down route); a verified person on a checked account.
export const ActorType = {
    PersonVerified: "person-verified",
    PersonDeclared: "person-declared",
    Agent: "agent",
    Ci: "ci",
    Unverified: "unverified",
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

// The actor types that count as a person. Both gate and count alike; only the label differs.
// Nothing requires a second person. Every gate, metric and level tests membership of this list
// rather than comparing with one person type, so a declared approval is never left out.
export const PERSON_ACTOR_TYPES: readonly ActorType[] = Object.freeze([
    ActorType.PersonVerified,
    ActorType.PersonDeclared,
]);

// Only the approval verifier and core's runtime build this, so a caller cannot choose its own actor
// type. Code that records an event receives one and passes it on.
export type DerivedActor = Brand<
    { readonly actor: ActorId; readonly actorType: ActorType },
    "DerivedActor"
>;

export const AuditEventKind = {
    PlanSubmitted: "plan.submitted",
    PlanRejected: "plan.rejected",
    PlanDenied: "plan.denied",
    PlanApproved: "plan.approved",
    ApprovalRefused: "approval.refused",
    TrustedChangedWithCode: "trusted.changed-with-code",
    RunFinished: "run.finished",
    ReviewDecided: "review.decided",
    SeverityOverridden: "severity.overridden",
    AdapterAdmitted: "adapter.admitted",
    PackAdmitted: "pack.admitted",
    CheckRemoved: "check.removed",
    TrackerChanged: "tracker.changed",
    HoldoutAccessRefused: "holdout.access-refused",
} as const;
export type AuditEventKind = (typeof AuditEventKind)[keyof typeof AuditEventKind];

// What a caller records. The actor is passed separately, as a DerivedActor.
export type EventInput = {
    readonly kind: AuditEventKind;
    readonly subjectHash?: string;
    readonly runId?: string;
    readonly criterionIds?: readonly string[];
    // On plan.approved and approval.refused: the route the approval was offered by.
    readonly proofKind?: ApprovalProof["kind"];
    // On approval.refused: why the approval verifier refused it. On plan.denied: the policy rule.
    readonly code?: ApprovalErrorCode | PolicyRuleId;
    // On trusted.changed-with-code: the trusted file the change edited, relative to the repository root.
    readonly path?: string;
    // On plan.submitted and plan.rejected: where the draft came from, as recorded, never trusted.
    readonly planProvenance?: PlanProvenance;
};

// not-append-only: the file no longer holds exactly what the sink wrote, so something else
// truncated or rewrote it. write-failed: the file system refused the write.
export const SinkErrorCode = {
    NotAppendOnly: "not-append-only",
    WriteFailed: "write-failed",
} as const;
export type SinkErrorCode = (typeof SinkErrorCode)[keyof typeof SinkErrorCode];
export type SinkError = { readonly code: SinkErrorCode };

// The audit sink: append-only, one entry per event. The audit log later wraps it with a hash
// chain and an anchor. A run's step log (RunEventSink in engine) is separate.
export interface EventSink {
    append(
        event: EventInput,
        actor: DerivedActor,
    ): Result<{ readonly sequence: number }, SinkError>;
}
