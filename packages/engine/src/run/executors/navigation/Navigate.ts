import { NavigateScripts, stepFailed, StepOutcome, type StepByType } from "@revisum/contracts";
import type { StepExecutor } from "../StepExecutor.ts";
import { pageUrl } from "./PageUrl.ts";

export const navigate: StepExecutor<StepByType["navigate"]> = async (step, context) => {
    const url = pageUrl(step.url, context.index, context);
    if (!url.ok) {
        return stepFailed(url.error);
    }
    const navigated = await context.document.navigate(url.value.href, {
        scripts: step.scripts ?? NavigateScripts.Enabled,
    });
    return navigated.ok ? { outcome: StepOutcome.Passed } : stepFailed(navigated.error.code);
};
