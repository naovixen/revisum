export const StepOutcome = {
    Passed: "passed",
    Failed: "failed",
    Skipped: "skipped",
} as const;

export type StepOutcome = (typeof StepOutcome)[keyof typeof StepOutcome];
