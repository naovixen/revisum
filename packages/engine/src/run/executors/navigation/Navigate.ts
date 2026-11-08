import { stepFailed, StepOutcome } from "@revisum/contracts";
import type { RunNavigateStep } from "../../../RunStep.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";
import { pageUrl } from "./PageUrl.ts";

export const navigate: StepExecutor<
    RunNavigateStep,
    StepNeeds<"values" | "cleared" | "gate" | "inputs" | "index" | "document">
> = async (step, context) => {
    const url = pageUrl(step.url, context.index, context);
    if (!url.ok) {
        return url.error;
    }
    const navigated = await context.document.navigate(url.value.href, step.navigation);
    return navigated.ok ? { outcome: StepOutcome.Passed } : stepFailed(navigated.error.code);
};
