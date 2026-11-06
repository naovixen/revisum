// Whether a plan may reach the project's production origins. Production is closed to every plan
// unless the project opens it, and then only to approved plans. The policy gate judges a plan by
// this, and a cleared run's origins are opened by it, so the two cannot disagree.
import type { PlanStanding } from "../approval/plan-standing.ts";
import type { ProjectPolicy } from "../project/project-parser.ts";

// The standing must already be the plan's own (ownStanding), never another plan's.
export const isProductionAllowed = (standing: PlanStanding, policy: ProjectPolicy): boolean =>
    standing.mode === "approved" && policy.allowProductionForApprovedPlans;
