import { stepFailed, StepOutcome } from "@revisum/contracts";
import type { RunStepByType } from "../../../RunStep.ts";
import { codeForThrow } from "../../CodeForThrow.ts";
import { pageUrl } from "../navigation/PageUrl.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// Opens the step's URL in a second tab of the session's browser context, runs its steps there in
// order and closes the tab, whatever they did. A tab that will not close fails a step that had
// passed, and never takes the place of a real failure.
export const openNewTab: StepExecutor<RunStepByType["newTab"]> = async (step, context) => {
    const url = pageUrl(step.url, context.index, context);
    if (!url.ok) {
        return stepFailed(url.error);
    }
    const opened = await context.session.newTab(url.value.href);
    if (!opened.ok) {
        return stepFailed(opened.error.code);
    }
    const tab = opened.value;
    const done = await context.runInnerSteps(step, context.index, tab);
    try {
        await tab.close();
        return done;
    } catch (error) {
        const code = codeForThrow(error, tab, context.logger);
        return done.outcome === StepOutcome.Passed ? { ...done, ...stepFailed(code) } : done;
    }
};
