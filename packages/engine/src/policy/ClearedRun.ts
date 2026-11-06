// A run the policy gate cleared: the plan, the project it was judged under, the target it runs on
// and the plan's own standing, held together, so a run under any other project, target or standing
// cannot be expressed. Only the gate makes one, and run() takes nothing else.
import type { Authorised, TargetId } from "@revisum/contracts";
import type { PlanStanding } from "../approval/plan-standing.ts";
import type { Project } from "../project/project-parser.ts";

export type ClearedRunFields = {
    readonly plan: Authorised;
    // A trusted project is a Project too.
    readonly project: Project;
    // The run looks the target up in the project's matrix by this id; one the matrix or the plan
    // does not declare ends the run TargetUnavailable with not-declared.
    readonly targetId: TargetId;
    // Already the plan's own (ownStanding): a standing lent from another plan was judged as a proposal.
    readonly standing: PlanStanding;
};

// A class only for its private field: an object written by hand, a copy or a spread of a cleared
// run has none, so it neither type-checks as one nor passes isCleared. The engine exports only the
// type, and only the gate calls the constructor.
export class ClearedRun {
    readonly plan: Authorised;
    readonly project: Project;
    readonly targetId: TargetId;
    readonly standing: PlanStanding;
    readonly #madeByTheGate = true;

    constructor(fields: ClearedRunFields) {
        this.plan = fields.plan;
        this.project = fields.project;
        this.targetId = fields.targetId;
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
