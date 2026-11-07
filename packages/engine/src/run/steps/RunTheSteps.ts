// Runs the plan's steps in order and gives them a verdict, then closes the session, whatever happened.
import { StepCode, type AppliedRewrite, type Session, type StubAnswer } from "@revisum/contracts";
import { finish, start, type Denial, type Resolved } from "../../lifecycle.ts";
import {
    observedRequestNames,
    startObserving,
} from "../../network-and-storage/network-and-storage-steps.ts";
import type { RunStep } from "../../RunStep.ts";
import { readKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import { codeForThrow } from "../CodeForThrow.ts";
import { networkContext } from "../executors/network-and-storage/NetworkAndStorageExecutors.ts";
import { ExecutorOutcome, type RanStep, type SessionContext } from "../executors/StepExecutor.ts";
import { closeKeepingTheResult } from "../session/CloseKeepingTheResult.ts";
import { failedStep, type StepResult } from "../StepResult.ts";
import { runPlanStep } from "./RunPlanStep.ts";
import { verdictOfSteps, type FinishedRun, type StepsRun } from "./VerdictOfSteps.ts";

// What the steps have given so far, kept as each ends, so a log or clock that fails part way still
// leaves every step accounted for.
type StepsSoFar = {
    readonly steps: StepResult[];
    readonly stepMilliseconds: number[];
    readonly denials: Denial[];
    readonly setupFailedInside: Set<number>;
};

export async function runTheSteps(
    context: SessionContext,
    resolved: Resolved,
    adapter: string,
    isPlanLogged: boolean,
): Promise<StepsRun> {
    const { session, logger, ports } = context;
    const targetId = context.cleared.target.id;
    const running = start(resolved);
    const soFar: StepsSoFar = {
        steps: [],
        stepMilliseconds: [],
        denials: [],
        setupFailedInside: new Set(),
    };
    let stubAnswers: readonly StubAnswer[];
    let rewrites: readonly AppliedRewrite[];
    let finished: FinishedRun;
    try {
        if (!isPlanLogged) {
            throw new Error("the log could not be written");
        }
        // The hash as it stands before the steps: a run whose proxy then rewrites a response ends with another.
        logger.log({
            kind: "run.state",
            state: resolved.state,
            targetId,
            adapter,
            sha256: resolved.manifestHash,
        });
        logger.log({ kind: "run.state", state: running.state, targetId });
        await runEachStep(context, soFar);
        // In the try: a port that cannot say what it rewrote must not leave a mutated run reading as plain.
        rewrites = ports.rewritesApplied?.() ?? [];
        finished = verdictOfSteps(soFar.steps, running, soFar);
    } catch {
        // A step's own failures never get here, so only the log or the clock can have failed. The result
        // still accounts for every step.
        pushUnfinishedSteps(context.planSteps, soFar.steps);
        finished = finish(running, "Errored");
        rewrites = readKeepingTheResult(() => ports.rewritesApplied?.() ?? [], [], logger);
    } finally {
        // Read before the browser goes, with every answer the stubs gave.
        stubAnswers = readKeepingTheResult(() => session.network.stubAnswers(), [], logger);
        await closeKeepingTheResult(session, ports.clock, logger);
    }
    return {
        running,
        steps: soFar.steps,
        stepMilliseconds: soFar.stepMilliseconds,
        stubAnswers,
        rewrites,
        finished,
    };
}

// Keeps what only a top-level step's outcome says, and gives the result it stands as in the plan's list.
function keepOutcome(step: RunStep, index: number, ran: RanStep, soFar: StepsSoFar): StepResult {
    switch (ran.outcome) {
        case ExecutorOutcome.Denied:
            soFar.denials.push(ran.denial);
            return failedStep(step, index, StepCode.PolicyDenied);
        case ExecutorOutcome.SetupFailedInside:
            soFar.setupFailedInside.add(index);
            return ran.failed;
        default:
            return ran;
    }
}

// Each step in order, with its result and duration pushed as it ends. After a failed step, every
// later one is skipped.
async function runEachStep(context: SessionContext, soFar: StepsSoFar): Promise<void> {
    const { session, logger, ports, planSteps } = context;
    const { steps, stepMilliseconds } = soFar;
    const notObserved = await failureToObserveRequests(session, context);
    for (const [index, step] of planSteps.entries()) {
        if (steps.some((done) => done.outcome === "failed")) {
            steps.push({ index, type: step.type, outcome: "skipped" });
            continue;
        }
        const stepStartedAt = ports.clock.now();
        logger.log({ kind: "step.start", stepIndex: index, stepType: step.type });
        // The first step stands for what could not be started, so the result says why nothing ran.
        const ran =
            index === 0 && notObserved !== undefined
                ? failedStep(step, index, notObserved)
                : await runPlanStep(step, index, session, context);
        const done = keepOutcome(step, index, ran, soFar);
        // With no later step to notice, a crash the last step did not report would go unseen.
        const isLastStep = index === planSteps.length - 1;
        const result =
            isLastStep && done.outcome === "passed" && session.crashed()
                ? failedStep(step, index, StepCode.TargetCrashed)
                : done;
        stepMilliseconds.push(ports.clock.now() - stepStartedAt);
        steps.push(result);
        logger.log({
            kind: "step.end",
            stepIndex: index,
            stepType: step.type,
            outcome: result.outcome,
            durationMilliseconds: stepMilliseconds[stepMilliseconds.length - 1] ?? 0,
            ...(result.code === undefined ? {} : { code: result.code }),
        });
    }
}

// Adds to the steps the one that was running when the log or the clock failed, as failed, and every
// one after it, as skipped.
function pushUnfinishedSteps(planSteps: readonly RunStep[], steps: StepResult[]): void {
    const [unfinished, ...unreached] = planSteps.slice(steps.length);
    if (unfinished !== undefined) {
        steps.push(failedStep(unfinished, steps.length, StepCode.AdapterError));
    }
    for (const step of unreached) {
        steps.push({ index: steps.length, type: step.type, outcome: "skipped" });
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
