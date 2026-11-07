// A step's result in the plan's list, and how long it took when it ran, kept together.
import type { StepResult } from "../StepResult.ts";

export const TimedStepKind = {
    Ran: "ran",
    NotRun: "not-run",
} as const;

export type TimedStepKind = (typeof TimedStepKind)[keyof typeof TimedStepKind];

// A step skipped, or cut short by a failing log or clock, did not run to an end, so has no duration.
export type TimedStep =
    | {
          readonly kind: typeof TimedStepKind.Ran;
          readonly result: StepResult;
          readonly milliseconds: number;
      }
    | { readonly kind: typeof TimedStepKind.NotRun; readonly result: StepResult };

export const ranStep = (result: StepResult, milliseconds: number): TimedStep => ({
    kind: TimedStepKind.Ran,
    result,
    milliseconds,
});

export const stepNotRun = (result: StepResult): TimedStep => ({
    kind: TimedStepKind.NotRun,
    result,
});

export const resultsOf = (steps: readonly TimedStep[]): StepResult[] =>
    steps.map((step) => step.result);

// The durations of the steps that ran to an end, in plan order.
export const durationsOf = (steps: readonly TimedStep[]): number[] =>
    steps.flatMap((step) => (step.kind === TimedStepKind.Ran ? [step.milliseconds] : []));
