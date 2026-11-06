// What a plan reaches beyond the browser, anywhere in it, its cleanup included.
import type { Plan } from "@revisum/contracts";
import { everyPlanStep } from "./plan-parser.ts";
import { STEP_FACTS, StepSection } from "./StepFacts.ts";

const holdsStepOf = (plan: Plan, section: StepSection): boolean =>
    everyPlanStep(plan).some((step) => STEP_FACTS[step.type].section === section);

// True when the plan calls a declared service.
export const callsServices = (plan: Plan): boolean => holdsStepOf(plan, StepSection.ServiceCalls);

// True when the plan runs a database command.
export const runsDatabaseCommands = (plan: Plan): boolean =>
    holdsStepOf(plan, StepSection.DatabaseCommands);
