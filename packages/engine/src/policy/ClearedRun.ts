// A run the policy gate cleared: the plan, the project it was judged under, the target it runs on
// and the plan's own standing, held together, so a run under any other project, target or standing
// cannot be expressed. Only the gate makes one, only for a target both the plan and the project's
// matrix declare, and run() takes nothing else.
import type { Authorised, Target, TargetId } from "@revisum/contracts";
import type { PlanStanding } from "../approval/PlanStanding.ts";
import type { Project } from "../project/ParseProject.ts";

export type ClearedRunFields = {
    readonly plan: Authorised;
    // A trusted project is a Project too.
    readonly project: Project;
    // The project's matrix entry for a target the plan names too, as the gate judged it.
    readonly target: Target;
    // Already the plan's own (ownStanding): a standing lent from another plan was judged as a proposal.
    readonly standing: PlanStanding;
};

// Tells a cleared run apart from the gate's other outcomes for a target.
export const ClearedRunKind = "cleared";

// A class only for its private field: an object written by hand, a copy or a spread of a cleared
// run has none, so it neither type-checks as one nor passes isCleared. The engine exports only the
// type, and only the gate calls the constructor.
export class ClearedRun {
    readonly kind = ClearedRunKind;
    readonly plan: Authorised;
    readonly project: Project;
    readonly target: Target;
    // The target's id, as results and logs name it.
    readonly targetId: TargetId;
    readonly standing: PlanStanding;
    readonly #madeByTheGate = true;

    constructor(fields: ClearedRunFields) {
        this.plan = fields.plan;
        this.project = fields.project;
        this.target = fields.target;
        this.targetId = fields.target.id;
        this.standing = fields.standing;
        // No field can be swapped after the gate judged them together.
        Object.freeze(this);
    }

    // True only for an object the constructor made, whatever a cast says.
    static isCleared(value: unknown): value is ClearedRun {
        return typeof value === "object" && value !== null && #madeByTheGate in value;
    }
}

// The run-time half of the type: run() calls this before any side effect, so an object the gate did
// not make is refused, whatever its type says.
export function assertCleared(cleared: unknown): asserts cleared is ClearedRun {
    if (!ClearedRun.isCleared(cleared)) {
        throw new TypeError("refused a run that the policy gate did not clear");
    }
}
