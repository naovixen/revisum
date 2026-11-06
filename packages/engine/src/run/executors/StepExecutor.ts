// What every step executor is: a function from one step and its context to what the step's result
// records. The run adds the index and type, and judges what no executor can see alone: a crash, a
// denial, a popup no step asked for.
import type { DocumentSession, Session, StepType } from "@revisum/contracts";
import type { ContainerRunStep, RunStep, RunStepByType } from "../../RunStep.ts";
import type { RunContext } from "../RunContext.ts";
import type { StepResult } from "../StepResult.ts";

// The run's context once its session is open.
export type SessionContext = RunContext & { readonly session: Session };

// What a step's result holds beyond its index and type.
export type StepRecord = Omit<StepResult, "index" | "type">;

// Runs the steps a frame or a second tab holds, in the document they stand in, and gives the
// container's result. Handed to the executors in their context, so a recursive step never imports
// the run that runs it.
export type RunInnerSteps = (
    container: ContainerRunStep,
    index: number,
    document: DocumentSession,
) => Promise<StepResult>;

// What a step runs with: the run's context, the index the step reports under, the document it acts
// on (the top document, or an iframe's for the steps inside a frame step, which report under the
// frame step's own index), and how to run the steps inside it.
export type StepContext = SessionContext & {
    readonly index: number;
    readonly document: DocumentSession;
    readonly runInnerSteps: RunInnerSteps;
};

// An executor that needs nothing from the browser may answer at once.
export type StepExecutor<TypedStep extends RunStep> = (
    step: TypedStep,
    context: StepContext,
) => Promise<StepRecord> | StepRecord;

// One executor per step type: a new type does not compile until it has one.
export type StepExecutorTable = { readonly [Type in StepType]: StepExecutor<RunStepByType[Type]> };
