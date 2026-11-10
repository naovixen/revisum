import { stepFailed } from "@revisum/contracts";
import type { RunStepByType } from "../../steps/RunStep.ts";
import { resolveLocator } from "../../values/RunValues.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";

// Runs a frame step's steps inside the iframe its locator finds.
export const enterFrame: StepExecutor<
    RunStepByType["frame"],
    StepNeeds<"values" | "cleared" | "document" | "runInnerSteps">
> = async (step, context) => {
    const locator = resolveLocator(step.locator, context.values, context.cleared.project);
    if (!locator.ok) {
        return stepFailed(locator.error);
    }
    const entered = await context.document.frame(locator.value);
    if (!entered.ok) {
        return stepFailed(entered.error.code);
    }
    return context.runInnerSteps(step, entered.value);
};
