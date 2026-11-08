// What every step executor is: a function from one step and its context to what the step's result
// records. The run adds the index and type, and judges what no executor can see alone: a crash, a
// popup no step asked for.
import type {
    Denial,
    DocumentSession,
    DownloadedFile,
    DownloadName,
    ResolvedLocator,
    Session,
    StepRecord,
    RanStepResult,
    StepType,
    StubName,
} from "@revisum/contracts";
import type { ContainerRunStep, RunStep, RunStepByType } from "../../RunStep.ts";
import type { RunContext } from "../RunContext.ts";

// The run's context once its session is open.
export type SessionContext = RunContext & { readonly session: Session };

// The two outcomes of a step that its record alone cannot say.
export const ExecutorOutcome = {
    // The runtime guard denied the step's action. The audit log holds the denial, so whatever the
    // driver reported or threw from the same moment never turns it into an ordinary failure.
    Denied: "denied",
    // A frame or second tab failed on a setup step inside it. The frame or newTab step reports under
    // its own type, so its type alone cannot say the run could not test.
    SetupFailedInside: "setup-failed-inside",
} as const;

export type DeniedStep = {
    readonly outcome: typeof ExecutorOutcome.Denied;
    readonly denial: Denial;
};

export type SetupFailedInside<Failed extends StepRecord> = {
    readonly outcome: typeof ExecutorOutcome.SetupFailedInside;
    readonly failed: Failed;
};

// What an executor gives back: the step's record, or one of the outcomes a record cannot say.
export type ExecutedStep = StepRecord | DeniedStep | SetupFailedInside<StepRecord>;

// What the run made of one step, wherever in the plan it stands.
export type RanStep = RanStepResult | DeniedStep | SetupFailedInside<RanStepResult>;

export const deniedStep = (denial: Denial): DeniedStep => ({
    outcome: ExecutorOutcome.Denied,
    denial,
});

export const setupFailedInside = <Failed extends StepRecord>(
    failed: Failed,
): SetupFailedInside<Failed> => ({ outcome: ExecutorOutcome.SetupFailedInside, failed });

// Runs the steps a frame or a second tab holds, in the document they stand in, and gives the
// container's outcome, under the container's own index. Handed to the executors in their context, so
// a recursive step never imports the run that runs it.
export type RunInnerSteps = (
    container: ContainerRunStep,
    document: DocumentSession,
) => Promise<RanStep>;

// What a step runs with: the run's context, the index the step reports under, the document it acts
// on (the top document, or an iframe's for the steps inside a frame step, which report under the
// frame step's own index), and how to run the steps inside it.
export type StepContext = SessionContext & {
    readonly index: number;
    readonly document: DocumentSession;
    readonly runInnerSteps: RunInnerSteps;
};

// The run's records, which only the step that keeps each may write: every other step reads them.
type RunRecordsRead = {
    readonly secretFilledFields: ReadonlyMap<string, ResolvedLocator>;
    readonly downloads: ReadonlyMap<DownloadName, DownloadedFile>;
    readonly rememberedTexts: ReadonlySet<string>;
    readonly activeStubs: ReadonlySet<StubName>;
};

type StepContextRead = Omit<StepContext, keyof RunRecordsRead> & RunRecordsRead;

// What an executor declares it uses: only these, and the run's records read-only.
export type StepNeeds<Field extends keyof StepContextRead> = Pick<StepContextRead, Field>;

// An executor that needs nothing from the browser may answer at once. It names what it uses of the
// context, so the table still hands it everything and no executor can reach for more.
export type StepExecutor<TypedStep extends RunStep, Context = StepContext> = (
    step: TypedStep,
    context: Context,
) => Promise<ExecutedStep> | ExecutedStep;

// One executor per step type: a new type does not compile until it has one.
export type StepExecutorTable = { readonly [Type in StepType]: StepExecutor<RunStepByType[Type]> };
