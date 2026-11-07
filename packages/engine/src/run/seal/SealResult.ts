// Sealing a plan run's result: the run mode, the guarantee statement, the unsafe label (for a plan
// using unsafe features), the approval label (for an approved plan) and the result's two hashes.
import type { GuaranteeStatement, UnsafeFeature } from "@revisum/contracts";
import { approvalLabel } from "../../approval/plan-standing.ts";
import { guaranteeStatement } from "../../guarantees.ts";
import type { Logger } from "../../logging.ts";
import { callsServices } from "../../plan/CallsServices.ts";
import { unsafeFeaturesOf } from "../../plan/unsafe-features.ts";
import type { TargetNotDeclared } from "../../policy/TargetNotDeclared.ts";
import type { RunPorts } from "../RunContext.ts";
import { EGRESS_UNREAD, type RunResult } from "../RunResult.ts";
import { withRunHashes } from "./WithRunHashes.ts";

// What a result is for, whether or not a run was cleared for its target.
export type RunSubject = Pick<TargetNotDeclared, "plan" | "project" | "targetId" | "standing">;

// What a result is sealed with: the plan, project and standing it was judged as, which a target that
// is not declared has too.
export type SealContext = {
    readonly subject: RunSubject;
    readonly ports: Pick<RunPorts, "isolation">;
    readonly determinismUnpinned: boolean;
};
// What a run that ended before any step needs: the seal, and the log it ends on.
export type NothingRanContext = SealContext & {
    readonly ports: Pick<RunPorts, "clock">;
    readonly logger: Logger;
};

// What a result holds before it is sealed.
export type UnsealedResult = Omit<
    RunResult,
    "resultHash" | "evidenceHash" | "approvalLabel" | "mode" | "guarantees" | "unsafeFeatures"
>;

// What a plan run vouches for: decided by the plan, its project's recording setting, the run's
// isolation and the target's adapter alone, so two runs of one plan say the same, unless one leaves its
// egress unread, which loses the claim as it does for an evidence run. Egress, credentials and replay
// are claimed only for a run whose isolation port says the isolated runner enforced egress; any other
// run counts as running on the host.
const planRunGuarantees = (
    context: SealContext,
    unsafeFeatures: readonly UnsafeFeature[],
    isEgressUnread: boolean,
): GuaranteeStatement => {
    const { plan, project } = context.subject;
    const hasUnrecordedReplies = callsServices(plan) && project.replay?.recordReplies !== true;
    const isIsolated = context.ports.isolation.guaranteeLevel() === "isolated";
    return guaranteeStatement({
        mode: "plan",
        egressEnforced: isIsolated && !isEgressUnread,
        unmaskedScreenshotsKept: false,
        unsafeFeatures,
        ...(context.determinismUnpinned ? { determinismUnpinned: true } : {}),
        ...(hasUnrecordedReplies ? { repliesNotRecorded: true } : {}),
    });
};

export function sealResult(outcome: UnsealedResult, context: SealContext): RunResult {
    const standing = context.subject.standing;
    const unsafeFeatures = unsafeFeaturesOf(context.subject.plan);
    const isEgressUnread = (outcome.reviewItems ?? []).some((item) => item.code === EGRESS_UNREAD);
    const labelled = {
        ...outcome,
        mode: "plan" as const,
        guarantees: planRunGuarantees(context, unsafeFeatures, isEgressUnread),
        ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
    };
    return withRunHashes(
        standing.mode === "approved"
            ? { ...labelled, approvalLabel: approvalLabel(standing.approval) }
            : labelled,
    );
}
