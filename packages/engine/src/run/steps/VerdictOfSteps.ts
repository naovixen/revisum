// The verdict the plan's steps give the run.
import { StepCode, type AppliedRewrite, type StubAnswer } from "@revisum/contracts";
import { COMMAND_ERROR_CODES } from "../../database-commands/database-command-steps.ts";
import {
    deny,
    finish,
    type Denial,
    type DeniedRun,
    type Finished,
    type Running,
} from "../../lifecycle.ts";
import { isSetupStepType } from "../../plan/StepFacts.ts";
import { NO_ANSWER_CODES } from "../../service-calls/call-steps.ts";
import type { StepResult } from "../StepResult.ts";

export type FinishedRun = Finished<"Passed" | "Failed" | "Errored"> | DeniedRun;

// The steps' results and verdict, and what was read from the session before it closed.
export type StepsRun = {
    readonly running: Running;
    readonly steps: readonly StepResult[];
    readonly stepMilliseconds: readonly number[];
    readonly stubAnswers: readonly StubAnswer[];
    readonly rewrites: readonly AppliedRewrite[];
    readonly finished: FinishedRun;
};

export type StepsVerdict = Pick<StepsRun, "running" | "steps" | "finished">;

// What the steps gave beyond their results: the runtime guard's denials, in order, and the steps
// whose frame or second tab failed on a setup step inside it.
export type StepsFound = {
    readonly denials: readonly Denial[];
    readonly setupFailedInside: ReadonlySet<number>;
};

// The codes of a page script or a database command that could not give a result to check, in
// whatever step it ran, of a service call that got no answer, and of an adapter that threw: the run
// could not test, which is not a product failure.
const UNUSABLE_RESULT_CODES: readonly string[] = [
    StepCode.ScriptFailed,
    StepCode.ScriptTimeout,
    StepCode.ScriptResultInvalid,
    StepCode.ScriptResultTooLarge,
    StepCode.AdapterError,
    ...COMMAND_ERROR_CODES,
    ...NO_ANSWER_CODES,
];

// True when a failed step means the run could not test, wherever in the plan the step stands.
const couldNotTest = (done: StepResult, found: StepsFound): boolean =>
    done.outcome === "failed" &&
    (isSetupStepType(done.type) ||
        UNUSABLE_RESULT_CODES.some((code) => code === done.code) ||
        found.setupFailedInside.has(done.index));

// A denied action failed its step, so every later step was skipped and nothing ran after it. A
// failed call, page script or database command could not set up or reach what the test needs, and
// a page script that threw, hung or gave no usable result, or a backend check whose call got no
// answer, could not check it, which is not a product failure.
export function verdictOfSteps(
    steps: readonly StepResult[],
    running: Running,
    found: StepsFound,
): FinishedRun {
    const denial = found.denials[0];
    if (denial !== undefined && steps.some((done) => done.code === "policy-denied")) {
        return deny(running, denial);
    }
    if (steps.some((done) => couldNotTest(done, found))) {
        return finish(running, "Errored");
    }
    return finish(running, steps.every((done) => done.outcome === "passed") ? "Passed" : "Failed");
}
