// A step's result in the plan's list, and how long it took, kept together.
import type { StepResult } from "../StepResult.ts";

// A step skipped, or cut short by a failing log or clock, did not run to an end, so has no duration.
export type TimedStep = {
    readonly result: StepResult;
    readonly milliseconds: number | undefined;
};

export const resultsOf = (steps: readonly TimedStep[]): StepResult[] =>
    steps.map((step) => step.result);

// The durations of the steps that ran to an end, in plan order.
export const durationsOf = (steps: readonly TimedStep[]): number[] =>
    steps.flatMap((step) => (step.milliseconds === undefined ? [] : [step.milliseconds]));
