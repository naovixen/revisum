import { stepFailed, StepOutcome } from "@revisum/contracts";
import type { RunStepByType } from "../../../RunStep.ts";
import { pageUrl } from "../navigation/PageUrl.ts";
import type { StepExecutor } from "../StepExecutor.ts";
import { withTab } from "./WithTab.ts";

// Opens the step's URL in a second tab of the session's browser context, runs its steps there in
// order and closes the tab, whatever they did. A tab that will not close fails a step that had
// passed, and never takes the place of a real failure.
export const openNewTab: StepExecutor<RunStepByType["newTab"]> = async (step, context) => {
    const url = pageUrl(step.url, context.index, context);
    if (!url.ok) {
        return url.error;
    }
    const ran = await withTab(context.session, url.value.href, context.logger, (tab) =>
        context.runInnerSteps(step, tab),
    );
    if (!ran.ok) {
        return stepFailed(ran.error.code);
    }
    const { used: done, closed } = ran.value;
    return !closed.ok && done.outcome === StepOutcome.Passed
        ? { ...done, ...stepFailed(closed.error) }
        : done;
};
