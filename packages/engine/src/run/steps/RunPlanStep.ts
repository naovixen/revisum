// One step, wherever in the plan it stands, with what its driver alone cannot be trusted to report:
// a browser already dead, a check that passed from memory while it died, a throw, and a request the
// browser held. A denial is the executor's own outcome, and stands over all of these.
import {
    StepCode,
    StepOutcome,
    stepFailed,
    type DocumentSession,
    type Step,
    type RanStepResult,
    type StepResult,
    type StubName,
} from "@revisum/contracts";
import { isAssertionStepType, isSetupStepType } from "../../plan/StepFacts.ts";
import type { ContainerRunStep, RunStep } from "../../RunStep.ts";
import { codeForThrow } from "../CodeForThrow.ts";
import {
    ExecutorOutcome,
    setupFailedInside,
    type DeniedStep,
    type RanStep,
    type RunInnerSteps,
    type SessionContext,
} from "../executors/StepExecutor.ts";
import { executeStep } from "../executors/StepExecutors.ts";
import { failedStep } from "../FailedStep.ts";

export async function runPlanStep(
    step: RunStep,
    index: number,
    document: DocumentSession,
    context: SessionContext,
): Promise<RanStep> {
    const ran = await runStepOnLivePage(step, index, document, context);
    switch (ran.outcome) {
        case ExecutorOutcome.Denied:
            return ran;
        case ExecutorOutcome.SetupFailedInside:
            return setupFailedInside(withActiveStubs(step, ran.failed, context.activeStubs));
        default:
            return withActiveStubs(step, ran, context.activeStubs);
    }
}

async function runStepOnLivePage(
    step: RunStep,
    index: number,
    document: DocumentSession,
    context: SessionContext,
): Promise<RanStep> {
    if (document.crashed()) {
        return failedStep(step, index, StepCode.TargetCrashed);
    }
    const openingsBefore = document.unsupportedOpenings();
    // The steps inside a container report under the container's own index.
    const runInnerSteps: RunInnerSteps = (container, inner) =>
        runStepsInside(container, index, inner, context);
    try {
        const executed = await executeStep(step, { ...context, index, document, runInnerSteps });
        if (executed.outcome === ExecutorOutcome.Denied) {
            return deniedWhateverTheSessionSays(executed, document, context);
        }
        // A request the browser would not let go on stays held, so neither a pass nor a failure of this
        // step says anything about the app: the run could not test. The reason goes to the log at the end.
        const isRequestHeld = context.session.refusedRequestDecisions().length > 0;
        switch (executed.outcome) {
            case ExecutorOutcome.SetupFailedInside: {
                const failed: RanStepResult = { index, type: step.type, ...executed.failed };
                return setupFailedInside(
                    isRequestHeld ? { ...failed, ...stepFailed(StepCode.AdapterError) } : failed,
                );
            }
            default: {
                const done: RanStepResult = { index, type: step.type, ...executed };
                return isRequestHeld
                    ? { ...done, ...stepFailed(StepCode.AdapterError) }
                    : judgedOnLivePage(step, done, document, openingsBefore);
            }
        }
    } catch (error) {
        return failedStep(step, index, codeForThrow(error, document, context.logger));
    }
}

// The audit log holds the denial, so nothing the session says next changes it. The session is still
// asked about held requests, as after every step, and a read that throws is logged.
function deniedWhateverTheSessionSays(
    denied: DeniedStep,
    document: DocumentSession,
    context: SessionContext,
): DeniedStep {
    try {
        context.session.refusedRequestDecisions();
    } catch (error) {
        codeForThrow(error, document, context.logger);
    }
    return denied;
}

// A passed step's result once the page has had its say: a check that passed from memory while the
// page died, or a popup or a download that no step asked for, fails it, so a run cannot pass as if
// nothing had opened.
function judgedOnLivePage(
    step: RunStep,
    done: RanStepResult,
    document: DocumentSession,
    openingsBefore: number,
): RanStepResult {
    if (done.outcome !== StepOutcome.Passed) {
        return done;
    }
    if (isAssertionStepType(step.type) && document.crashed()) {
        return failedStep(step, done.index, StepCode.TargetCrashed);
    }
    return document.unsupportedOpenings() > openingsBefore
        ? failedStep(step, done.index, StepCode.UnsupportedStep)
        : done;
}

// True when a passed step left something beyond its outcome for a person to read.
const holdsARecord = (done: RanStepResult): boolean =>
    Object.keys(done).some((key) => key !== "index" && key !== "type" && key !== "outcome");

// The steps of a frame or newTab step, in order, in the document they stand in. They have no results
// of their own in the plan's list: the first that fails fails the frame or newTab step, with its code,
// observation and records, and the records of those before it are kept beside them. A denial inside
// is the container's denial.
async function runStepsInside(
    container: ContainerRunStep,
    index: number,
    document: DocumentSession,
    context: SessionContext,
): Promise<RanStep> {
    const kept: RanStepResult[] = [];
    const withKept = (result: RanStepResult, nested: readonly StepResult[] = []): RanStepResult =>
        kept.length + nested.length === 0
            ? result
            : { ...result, innerSteps: [...kept, ...nested] };
    for (const inner of container.steps) {
        const ran = await runPlanStep(inner, index, document, context);
        if (ran.outcome === ExecutorOutcome.Denied) {
            return ran;
        }
        const isSetupFailedInside = ran.outcome === ExecutorOutcome.SetupFailedInside;
        const done = ran.outcome === ExecutorOutcome.SetupFailedInside ? ran.failed : ran;
        if (done.outcome !== StepOutcome.Passed) {
            const failed = withKept({ ...done, type: container.type }, done.innerSteps);
            return isSetupFailedInside || isSetupStepType(inner.type)
                ? setupFailedInside(failed)
                : failed;
        }
        if (holdsARecord(done)) {
            kept.push(done);
        }
    }
    return withKept({ index, type: container.type, outcome: StepOutcome.Passed });
}

// An assertion's result with the stubs active while it ran, so a report can tell a check of a faked
// answer from a check of the real backend. A stub step never checks anything, so the stubs active
// as the step ends are the ones active while it ran.
function withActiveStubs(
    step: Step,
    result: RanStepResult,
    activeStubs: ReadonlySet<StubName>,
): RanStepResult {
    if (activeStubs.size === 0 || !isAssertionStepType(step.type)) {
        return result;
    }
    return { ...result, activeStubs: [...activeStubs].sort() };
}
