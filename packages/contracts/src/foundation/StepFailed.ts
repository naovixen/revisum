import type { StepCode } from "./StepCode.ts";
import { StepOutcome } from "./StepOutcome.ts";

export type StepFailure<Code extends StepCode = StepCode> = {
    readonly outcome: typeof StepOutcome.Failed;
    readonly code: Code;
};

// A step's failure holding only its code. Spread it into a result, and add a record after it:
// `{ ...base, ...stepFailed(code), observed }`.
export const stepFailed = <Code extends StepCode>(code: Code): StepFailure<Code> => ({
    outcome: StepOutcome.Failed,
    code,
});
