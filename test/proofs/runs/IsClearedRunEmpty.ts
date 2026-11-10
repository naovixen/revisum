// Compile-time guarantees around the policy gate. Type-checked by PolicyTypeGuarantees.test.ts
// and by TypeCheck.test.ts, never run.
//   - A run takes only a ClearedRun, and only the policy gate makes one: a parsed plan, the plan held
//     by a cleared run, an object written by hand and a spread copy of a cleared run all fail to
//     type-check as one. So no run can be written under a project, target or standing other than
//     the ones the gate judged together.
//   - The plan a cleared run holds is still a Plan, so everything that reads a plan reads it
//     unchanged.
// Each @ts-expect-error line must stay an error; the test deletes them to prove it.
import {
    createRunService,
    type ClearedRun,
    type Plan,
    type PlanStanding,
    type Project,
    type RunInputs,
    type RunPorts,
    type TargetId,
} from "@revisum/engine";

declare const inputs: RunInputs;
declare const ports: RunPorts;
declare const parsed: Plan;
declare const cleared: ClearedRun;
declare const otherProject: Project;
declare const otherTarget: TargetId;
declare const otherStanding: PlanStanding;

// True only for the empty type. A brand that collapsed to it would make every check below vacuous.
type IsNever<Type> = [Type] extends [never] ? true : false;
export const isClearedRunEmpty: IsNever<ClearedRun> = false;

export const clearedRunHoldsAPlan: Plan = cleared.plan;
export const clearedRunRuns = createRunService(ports).run(cleared, inputs);

// @ts-expect-error a parsed plan the policy gate has not cleared cannot be run
export const unclearedPlanRuns = createRunService(ports).run(parsed, inputs);

// @ts-expect-error the plan alone is not a cleared run: it names no project, target or standing
export const planOfAClearedRunRuns = createRunService(ports).run(cleared.plan, inputs);

export const handMadeClearedRunRuns = createRunService(ports).run(
    // @ts-expect-error a cleared run written by hand is not one: only the policy gate makes one
    { plan: cleared.plan, project: otherProject, targetId: otherTarget, standing: otherStanding },
    inputs,
);

export const clearedRunUnderAnotherProject = createRunService(ports).run(
    // @ts-expect-error a spread copy of a cleared run under another project is not one
    { ...cleared, project: otherProject },
    inputs,
);

export const clearedRunUnderAnotherStanding = createRunService(ports).run(
    // @ts-expect-error a spread copy of a cleared run under another standing is not one
    { ...cleared, standing: otherStanding },
    inputs,
);

// @ts-expect-error a copy of a parsed plan is not a cleared run: only the policy gate makes one
export const forgedClearedRun: ClearedRun = { ...parsed };
