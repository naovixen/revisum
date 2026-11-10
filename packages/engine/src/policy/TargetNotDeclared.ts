// What the policy gate gives, in place of a cleared run, for a target the plan or the project's
// matrix does not declare: nothing may run on it. It carries what the plan was judged as, so the
// target's result can still say which plan and standing it was for.
import { UnavailableReason, type Plan, type TargetId } from "@revisum/contracts";
import type { PlanStanding } from "../approval/PlanStanding.ts";
import type { Project } from "../project/ParseProject.ts";

export type TargetNotDeclared = {
    readonly kind: typeof UnavailableReason.NotDeclared;
    readonly plan: Plan;
    readonly project: Project;
    readonly targetId: TargetId;
    // Already the plan's own (ownStanding).
    readonly standing: PlanStanding;
};

export const targetNotDeclared = (fields: Omit<TargetNotDeclared, "kind">): TargetNotDeclared => ({
    kind: UnavailableReason.NotDeclared,
    ...fields,
});
