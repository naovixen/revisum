// Compile-time guarantees around the policy gate. Type-checked by policy-type-guarantees.test.ts
// and by type-check.test.ts, never run.
//   - A run takes only an Authorised plan, and only the policy gate makes one: a plan the parser
//     made but the gate has not authorised does not type-check as a run's plan, and neither does a
//     copy of a parsed plan.
//   - An Authorised plan is still a Plan, so everything that reads a plan reads it unchanged.
// Each @ts-expect-error line must stay an error; the test deletes them to prove it.
// See docs/specs/SPEC-03-policy-gate.md.
import { run, type Authorised, type Plan, type RunInputs, type RunPorts } from '@revisum/engine';

declare const inputs: RunInputs;
declare const ports: RunPorts;
declare const parsed: Plan;
declare const authorised: Authorised;

// True only for the empty type. A brand that collapsed to it would make every check below vacuous.
type IsNever<Type> = [Type] extends [never] ? true : false;
export const authorisedIsARealType: IsNever<Authorised> = false;

export const authorisedIsAPlan: Plan = authorised;
export const authorisedPlanRuns = run({ ...inputs, plan: authorised }, ports);

// @ts-expect-error a parsed plan the policy gate has not authorised cannot be run
export const unauthorisedPlanRuns = run({ ...inputs, plan: parsed }, ports);

// @ts-expect-error a copy of a parsed plan is not Authorised: only the policy gate makes one
export const forgedAuthorised: Authorised = { ...parsed };
