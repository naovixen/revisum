// Runs the plan's steps in order and gives them a verdict, reading what the session must give before it closes.
import {
    StepCode,
    StepOutcome,
    type Denial,
    type Session,
    type StepResult,
} from "@revisum/contracts";
import { finish, start, type Resolved, type Running } from "../outcome/Transition.ts";
import {
    observedRequestNames,
    startObserving,
} from "../executors/network-and-storage/CheckRequests.ts";
import type { RunStep } from "./RunStep.ts";
import {
    logFailureAfterTheVerdict,
    readRecord,
} from "../after-the-verdict/ReadKeepingTheResult.ts";
import { codeForThrow } from "../CodeForThrow.ts";
import { networkContext } from "../executors/network-and-storage/NetworkAndStorageExecutors.ts";
import { ExecutorOutcome, type RanStep, type SessionContext } from "../executors/StepExecutor.ts";
import { failedStep } from "../FailedStep.ts";
import { runPlanStep } from "./RunPlanStep.ts";
import { ranStep, resultsOf, stepNotRun, type TimedStep } from "./TimedStep.ts";
import { verdictOfSteps, type FinishedRun, type StepsRun } from "./VerdictOfSteps.ts";
import { EventKind } from "../logging/LoggingManifest.ts";

// What the steps have given so far, kept as each ends, so a log or clock that fails part way still
// leaves every step accounted for.
type StepsSoFar = {
    readonly steps: TimedStep[];
    denial: Denial | undefined;
    readonly setupFailedInside: Set<number>;
};

const nothingSoFar = (): StepsSoFar => ({
    steps: [],
    denial: undefined,
    setupFailedInside: new Set(),
});

export async function runTheSteps(
    context: SessionContext,
    resolved: Resolved,
    adapter: string,
): Promise<StepsRun> {
    const { logger } = context;
    const targetId = context.cleared.target.id;
    const running = start(resolved);
    const soFar = nothingSoFar();
    try {
        // The hash as it stands before the steps: a run whose proxy then rewrites a response ends with another.
        logger.log({
            kind: EventKind.RunState,
            state: resolved.state,
            targetId,
            adapter,
            sha256: resolved.manifestHash,
        });
        logger.log({ kind: EventKind.RunState, state: running.state, targetId });
        await runEachStep(context, soFar);
    } catch (error) {
        // Only what the steps do not catch themselves gets here, such as a log or a clock that failed part
        // way. The result still accounts for every step.
        return endUnfinished(context, running, soFar, error);
    }
    return endOfTheSteps(
        context,
        running,
        soFar,
        verdictOfSteps(resultsOf(soFar.steps), running, soFar),
    );
}

// The steps of a run whose log failed before they began: none runs, and the run ends Errored, as one
// whose log fails part way does.
export function stepsNotRunForTheLog(context: SessionContext, resolved: Resolved): StepsRun {
    return endUnfinished(context, start(resolved), nothingSoFar(), "the log could not be written");
}

// Ends a run cut short: the step that was running fails and every later one is skipped.
function endUnfinished(
    context: SessionContext,
    running: Running,
    soFar: StepsSoFar,
    error: unknown,
): StepsRun {
    logFailureAfterTheVerdict(StepCode.AdapterError, error, context.logger);
    pushUnfinishedSteps(context.planSteps, soFar.steps);
    return endOfTheSteps(context, running, soFar, finish(running, "Errored"));
}

// What the session must give before it closes.
function endOfTheSteps(
    context: SessionContext,
    running: Running,
    soFar: StepsSoFar,
    verdict: FinishedRun,
): StepsRun {
    const { session, logger, ports } = context;
    // Asked once: a port that cannot say what it rewrote must not leave a mutated run reading as plain.
    const rewrites = readRecord(() => ports.rewritesApplied(), logger);
    // Read before the browser goes, with every answer the stubs gave.
    const stubAnswers = readRecord(() => session.network.stubAnswers(), logger);
    return { running, steps: soFar.steps, stubAnswers, rewrites, finished: verdict };
}

// Keeps what only a top-level step's outcome says, and gives the result it stands as in the plan's list.
function keepOutcome(step: RunStep, index: number, ran: RanStep, soFar: StepsSoFar): StepResult {
    switch (ran.outcome) {
        case ExecutorOutcome.Denied:
            soFar.denial = ran.denial;
            return failedStep(step, index, StepCode.PolicyDenied);
        case ExecutorOutcome.SetupFailedInside:
            soFar.setupFailedInside.add(index);
            return ran.failed;
        case StepOutcome.Passed:
        case StepOutcome.Failed:
            return ran;
    }
}

// Each step in order, with its result and duration pushed as it ends. After a failed step, every
// later one is skipped.
async function runEachStep(context: SessionContext, soFar: StepsSoFar): Promise<void> {
    const { session, logger, ports, planSteps } = context;
    const { steps } = soFar;
    const notObserved = await failureToObserveRequests(session, context);
    for (const [index, step] of planSteps.entries()) {
        if (steps.some((done) => done.result.outcome === StepOutcome.Failed)) {
            steps.push(stepNotRun({ index, type: step.type, outcome: StepOutcome.Skipped }));
            continue;
        }
        const stepStartedAt = ports.clock.now();
        logger.log({ kind: EventKind.StepStart, stepIndex: index, stepType: step.type });
        // The first step stands for what could not be started, so the result says why nothing ran.
        const ran =
            index === 0 && notObserved !== undefined
                ? failedStep(step, index, notObserved)
                : await runPlanStep(step, index, session, context);
        const done = keepOutcome(step, index, ran, soFar);
        // With no later step to notice, a crash the last step did not report would go unseen.
        const isLastStep = index === planSteps.length - 1;
        const result =
            isLastStep && done.outcome === StepOutcome.Passed && session.crashed()
                ? failedStep(step, index, StepCode.TargetCrashed)
                : done;
        const milliseconds = ports.clock.now() - stepStartedAt;
        steps.push(ranStep(result, milliseconds));
        logger.log({
            kind: EventKind.StepEnd,
            stepIndex: index,
            stepType: step.type,
            outcome: result.outcome,
            durationMilliseconds: milliseconds,
            ...(result.code === undefined ? {} : { code: result.code }),
        });
    }
}

// Adds to the steps the one that was running when the log or the clock failed, as failed, and every
// one after it, as skipped.
function pushUnfinishedSteps(planSteps: readonly RunStep[], steps: TimedStep[]): void {
    const [unfinished, ...unreached] = planSteps.slice(steps.length);
    if (unfinished !== undefined) {
        steps.push(stepNotRun(failedStep(unfinished, steps.length, StepCode.AdapterError)));
    }
    for (const step of unreached) {
        steps.push(
            stepNotRun({ index: steps.length, type: step.type, outcome: StepOutcome.Skipped }),
        );
    }
}

// The requests the plan checks are observed from its start, so what a page sends as it loads counts
// too. Gives the code for what stopped it, or undefined when nothing did.
async function failureToObserveRequests(
    session: Session,
    context: SessionContext,
): Promise<StepCode | undefined> {
    try {
        const observing = await startObserving(
            observedRequestNames(context.cleared.plan),
            networkContext(context),
        );
        if (observing.ok) {
            return undefined;
        }
        return codeForThrow(
            `the requests the plan checks could not be observed: ${observing.error}`,
            session,
            context.logger,
        );
    } catch (error) {
        return codeForThrow(error, session, context.logger);
    }
}
