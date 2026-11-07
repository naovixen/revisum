// What request decisions the browser refused after the verdict do to it.
import { StepCode, stepFailed } from "@revisum/contracts";
import { finish } from "../../lifecycle.ts";
import type { StepResult } from "../StepResult.ts";
import type { StepsVerdict } from "../steps/VerdictOfSteps.ts";

// The verdict once the late refusals are counted, and the step they spoilt, whose end the log must
// then tell again, as the result now does.
export type VerdictAfterRefusals =
    | { readonly isSpoilt: false; readonly verdict: StepsVerdict }
    | {
          readonly isSpoilt: true;
          readonly verdict: StepsVerdict;
          readonly spoiltStep: StepResult;
          readonly spoiltStepMilliseconds: number;
      };

// Read once the session has closed, when no decision is left waiting for the browser's answer. With
// no later step to report one the browser refused after the last step ended, the last step stands
// for it, as it does for a crash it missed: a run that passed fails that step with adapter-error and
// ends Errored. Any other verdict already says the run did not pass, and stands.
export function withRefusalsAfterTheVerdict(
    verdict: StepsVerdict,
    refusals: readonly string[],
): VerdictAfterRefusals {
    if (refusals.length === 0 || verdict.finished.state !== "Passed") {
        return { isSpoilt: false, verdict };
    }
    const finished = finish(verdict.running, "Errored");
    const lastStep = verdict.steps.at(-1);
    // Every step of a passed run ran to an end, so only a plan with no steps has none to spoil.
    if (lastStep?.milliseconds === undefined) {
        return { isSpoilt: false, verdict: { ...verdict, finished } };
    }
    const spoiltStep: StepResult = { ...lastStep.result, ...stepFailed(StepCode.AdapterError) };
    const steps = [
        ...verdict.steps.slice(0, -1),
        { result: spoiltStep, milliseconds: lastStep.milliseconds },
    ];
    return {
        isSpoilt: true,
        verdict: { running: verdict.running, steps, finished },
        spoiltStep,
        spoiltStepMilliseconds: lastStep.milliseconds,
    };
}
