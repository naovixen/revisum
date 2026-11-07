// What request decisions the browser refused after the verdict do to it.
import { StepCode, stepFailed, TerminalState, type FailedStep } from "@revisum/contracts";
import { finish } from "../../lifecycle.ts";
import { ranStep, TimedStepKind } from "../steps/TimedStep.ts";
import type { StepsVerdict } from "../steps/VerdictOfSteps.ts";

// The verdict once the late refusals are counted, and the step they spoilt, whose end the log must
// then tell again, as the result now does.
export type VerdictAfterRefusals =
    | { readonly isSpoilt: false; readonly verdict: StepsVerdict }
    | {
          readonly isSpoilt: true;
          readonly verdict: StepsVerdict;
          readonly spoiltStep: FailedStep;
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
    if (refusals.length === 0 || verdict.finished.state !== TerminalState.Passed) {
        return { isSpoilt: false, verdict };
    }
    const finished = finish(verdict.running, TerminalState.Errored);
    const lastStep = verdict.steps.at(-1);
    // A plan with no steps has none to spoil.
    if (lastStep === undefined) {
        return { isSpoilt: false, verdict: { ...verdict, finished } };
    }
    // Every step of a passed run ran to an end, so this is never so; were it, a step that did not run
    // has no end for the refusals to spoil.
    if (lastStep.kind === TimedStepKind.NotRun) {
        return { isSpoilt: false, verdict: { ...verdict, finished } };
    }
    const spoiltStep: FailedStep = { ...lastStep.result, ...stepFailed(StepCode.AdapterError) };
    const steps = [...verdict.steps.slice(0, -1), ranStep(spoiltStep, lastStep.milliseconds)];
    return {
        isSpoilt: true,
        verdict: { running: verdict.running, steps, finished },
        spoiltStep,
        spoiltStepMilliseconds: lastStep.milliseconds,
    };
}
