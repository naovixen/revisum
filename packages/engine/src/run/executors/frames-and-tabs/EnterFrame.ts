import { stepFailed } from "@revisum/contracts";
import type { RunStepByType } from "../../../RunStep.ts";
import { resolveLocator } from "../../../run-values.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// Runs a frame step's steps inside the iframe its locator finds.
export const enterFrame: StepExecutor<RunStepByType["frame"]> = async (step, context) => {
    const locator = resolveLocator(step.locator, context.values, context.cleared.project);
    if (!locator.ok) {
        return stepFailed(locator.error);
    }
    const entered = await context.document.frame(locator.value);
    if (!entered.ok) {
        return stepFailed(entered.error.code);
    }
    return context.runInnerSteps(step, context.index, entered.value);
};
