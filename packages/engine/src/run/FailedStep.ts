import { stepFailed, type FailedStep, type Step, type StepCode } from "@revisum/contracts";

// A failed step's result that holds only its code.
export const failedStep = (step: Step, index: number, code: StepCode): FailedStep => ({
    index,
    type: step.type,
    ...stepFailed(code),
});
