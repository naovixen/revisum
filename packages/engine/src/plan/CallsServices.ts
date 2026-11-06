// What a plan reaches beyond the browser, anywhere in it, its cleanup included.
import type { Plan } from "@revisum/contracts";
import { everyPlanStep } from "./plan-parser.ts";

// True when the plan calls a declared service.
export const callsServices = (plan: Plan): boolean =>
    everyPlanStep(plan).some((step) => step.type === "call" || step.type === "expectBackend");

// True when the plan runs a database command.
export const runsDatabaseCommands = (plan: Plan): boolean =>
    everyPlanStep(plan).some((step) => step.type === "database" || step.type === "expectDatabase");
