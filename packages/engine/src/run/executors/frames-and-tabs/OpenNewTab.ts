import { stepFailed } from "@revisum/contracts";
import type { RunStepByType } from "../../../RunStep.ts";
import { pageUrl } from "../navigation/PageUrl.ts";
import type { StepExecutor } from "../StepExecutor.ts";
import { withTab } from "./WithTab.ts";

// Opens the step's URL in a second tab of the session's browser context, runs its steps there in
// order and closes the tab, whatever they did.
export const openNewTab: StepExecutor<RunStepByType["newTab"]> = async (step, context) => {
    const url = pageUrl(step.url, context.index, context);
    if (!url.ok) {
        return url.error;
    }
    const ran = await withTab(context.session, url.value.href, (tab) =>
        context.runInnerSteps(step, tab),
    );
    return ran.ok ? ran.value : stepFailed(ran.error.code);
};
