// Sealing a plan run's result: the run mode, the guarantee statement, the unsafe label (for a plan
// using unsafe features), the approval label (for an approved plan) and the result's two hashes.
import {
    RunMode,
    type GuaranteeStatement,
    type PlanDeniedResult,
    type PlanDeniedThenErroredResult,
    type PlanRanResult,
    type PlanRefusedResult,
    type PlanRunResult,
    type TargetUnavailableResult,
    type PlanDriverBrokeResult,
    type UnsafeFeature,
} from "@revisum/contracts";
import { approvalLabel } from "../../approval/plan-standing.ts";
import { guaranteeStatement } from "../../guarantees.ts";
import type { Logger } from "../../logging.ts";
import { callsServices } from "../../plan/CallsServices.ts";
import { unsafeFeaturesOf } from "../../plan/unsafe-features.ts";
import type { TargetNotDeclared } from "../../policy/TargetNotDeclared.ts";
import type { RunPorts } from "../RunContext.ts";
import {
    RecordReadKind,
    readValueOr,
    recordRead,
    type RecordRead,
} from "../after-the-verdict/RecordRead.ts";
import {
    unreadRecordItems,
    type RecordsAfterTheSteps,
} from "../after-the-verdict/RecordsAfterTheSteps.ts";
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
    readonly startedAt: number;
};

// How long a run that ended before any step took.
export const runTimeOfNothingRan = (context: NothingRanContext): number =>
    context.ports.clock.now() - context.startedAt;

// What sealing adds to a plan run's result: its labels and its hashes.
export type SealedFields =
    "mode" | "guarantees" | "unsafeFeatures" | "approvalLabel" | "resultHash" | "evidenceHash";

// Each kind of result less the fields sealing adds, and any others named.
type Unsealed<Result, Others extends PropertyKey = never> = Result extends unknown
    ? Omit<Result, SealedFields | Others>
    : never;

// What a result holds before it is sealed.
type UnsealedResult = Unsealed<PlanRunResult>;

// What the result of a run that ended before any step holds before it is sealed.
export type UnsealedNothingRanResult = Unsealed<
    PlanRefusedResult | TargetUnavailableResult | PlanDriverBrokeResult
>;

// What a plan run vouches for: decided by the plan, its project's recording setting, the run's
// isolation and the target's adapter alone, so two runs of one plan say the same, unless one leaves its
// egress unread, which loses the claim as it does for an evidence run. Egress, credentials and replay
// are claimed only for a run whose isolation port says the isolated runner enforced egress; any other
// run counts as running on the host.
const planRunGuarantees = (
    context: SealContext,
    unsafeFeatures: readonly UnsafeFeature[],
    egress: RecordRead<readonly string[]>,
): GuaranteeStatement => {
    const { plan, project } = context.subject;
    const hasUnrecordedReplies = callsServices(plan) && project.replay?.recordReplies !== true;
    const isIsolated = context.ports.isolation.guaranteeLevel() === "isolated";
    return guaranteeStatement({
        mode: "plan",
        egressEnforced: isIsolated && egress.kind === RecordReadKind.Read,
        unmaskedScreenshotsKept: false,
        unsafeFeatures,
        ...(context.determinismUnpinned ? { determinismUnpinned: true } : {}),
        ...(hasUnrecordedReplies ? { repliesNotRecorded: true } : {}),
    });
};

// Seals the result of a run that ended before any step. It reads no egress record: the empty list of
// blocked origins its result holds stands for one.
export function sealResult(outcome: UnsealedNothingRanResult, context: SealContext): PlanRunResult {
    return seal(outcome, context, recordRead(outcome.blockedOrigins));
}

// What a result holds before it is sealed, less what the records read after the steps decide.
export type UnsealedRanResult = Unsealed<
    PlanRanResult | PlanDeniedResult | PlanDeniedThenErroredResult,
    "blockedOrigins" | "stubAnswers"
>;

// Seals the result of a run whose session closed. The one place the records read after its steps go
// into the result: the origins the egress refused and the stubs that answered, a review item for each
// record left unread, and no claim that egress was enforced when the egress could not say.
export function sealRanResult(
    outcome: UnsealedRanResult,
    context: SealContext,
    records: RecordsAfterTheSteps,
): PlanRunResult {
    const reviewItems = [...(outcome.reviewItems ?? []), ...unreadRecordItems(records)];
    const stubAnswers = readValueOr(records.stubAnswers, []);
    return seal(
        {
            ...outcome,
            blockedOrigins: readValueOr(records.egress, []),
            ...(reviewItems.length === 0 ? {} : { reviewItems }),
            ...(stubAnswers.length === 0 ? {} : { stubAnswers: [...stubAnswers] }),
        },
        context,
        records.egress,
    );
}

function seal(
    outcome: UnsealedResult,
    context: SealContext,
    egress: RecordRead<readonly string[]>,
): PlanRunResult {
    const standing = context.subject.standing;
    const unsafeFeatures = unsafeFeaturesOf(context.subject.plan);
    const labelled = {
        ...outcome,
        mode: RunMode.Plan,
        guarantees: planRunGuarantees(context, unsafeFeatures, egress),
        ...(unsafeFeatures.length === 0 ? {} : { unsafeFeatures }),
    };
    return withRunHashes(
        standing.mode === "approved"
            ? { ...labelled, approvalLabel: approvalLabel(standing.approval) }
            : labelled,
    );
}
