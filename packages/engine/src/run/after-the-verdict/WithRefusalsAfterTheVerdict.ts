// What request decisions the browser refused after the verdict do to it.
import { StepCode, stepFailed } from "@revisum/contracts";
import { finish } from "../../lifecycle.ts";
import type { StepsVerdict } from "../steps/VerdictOfSteps.ts";

// Read once the session has closed, when no decision is left waiting for the browser's answer. With
// no later step to report one the browser refused after the last step ended, the last step stands
// for it, as it does for a crash it missed: a run that passed fails that step with adapter-error and
// ends Errored. Any other verdict already says the run did not pass, and stands.
export function withRefusalsAfterTheVerdict(
    verdict: StepsVerdict,
    refusals: readonly string[],
): StepsVerdict {
    if (refusals.length === 0 || verdict.finished.state !== "Passed") {
        return verdict;
    }
    const lastIndex = verdict.steps.length - 1;
    const steps = verdict.steps.map((done, index) =>
        index === lastIndex ? { ...done, ...stepFailed(StepCode.AdapterError) } : done,
    );
    return { running: verdict.running, steps, finished: finish(verdict.running, "Errored") };
}
