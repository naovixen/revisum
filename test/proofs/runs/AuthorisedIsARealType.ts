// Compile-time guarantees around the policy gate. Type-checked by policy-type-guarantees.test.ts
// and by type-check.test.ts, never run.
//   - A run takes only a ClearedRun, and only the policy gate makes one: a parsed plan, a plan the
//     gate authorised, an object written by hand and a spread copy of a cleared run all fail to
//     type-check as one. So no run can be written under a project, target or standing other than
//     the ones the gate judged together.
//   - Only the policy gate makes an Authorised plan, and one is still a Plan, so everything that
//     reads a plan reads it unchanged.
// Each @ts-expect-error line must stay an error; the test deletes them to prove it.
import {
    createRunService,
    type Authorised,
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
declare const authorised: Authorised;
declare const cleared: ClearedRun;
declare const otherProject: Project;
declare const otherTarget: TargetId;
declare const otherStanding: PlanStanding;

// True only for the empty type. A brand that collapsed to it would make every check below vacuous.
type IsNever<Type> = [Type] extends [never] ? true : false;
export const authorisedIsARealType: IsNever<Authorised> = false;
export const isClearedRunEmpty: IsNever<ClearedRun> = false;

export const authorisedIsAPlan: Plan = authorised;
export const clearedRunHoldsAPlan: Plan = cleared.plan;
export const clearedRunRuns = createRunService(ports).run(cleared, inputs);

// @ts-expect-error a parsed plan the policy gate has not cleared cannot be run
export const unclearedPlanRuns = createRunService(ports).run(parsed, inputs);

// @ts-expect-error an authorised plan alone is not a cleared run: it names no project, target or standing
export const authorisedPlanRuns = createRunService(ports).run(authorised, inputs);

export const handMadeClearedRunRuns = createRunService(ports).run(
    // @ts-expect-error a cleared run written by hand is not one: only the policy gate makes one
    { plan: authorised, project: otherProject, targetId: otherTarget, standing: otherStanding },
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

// @ts-expect-error a copy of a parsed plan is not Authorised: only the policy gate makes one
export const forgedAuthorised: Authorised = { ...parsed };
