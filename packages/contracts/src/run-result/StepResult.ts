// What a run keeps of each step: where it stands in the plan, its outcome, and the records it left.
// A failed step always holds the code it failed with; a passed one holds a code only to say what it
// left out; a skipped one holds nothing else.
import type { A11yFinding } from "../ports/BrowserDriver.ts";
import type { StepCode } from "../foundation/StepCode.ts";
import type { StepOutcome } from "../foundation/StepOutcome.ts";
import type { StubName } from "../plan/steps/NetworkAndStorageStep.ts";
import type { DatabaseCommandRecord } from "./records/DatabaseCommandRecord.ts";
import type { DownloadRecord } from "./records/DownloadRecord.ts";
import type { PageScriptRecord } from "./records/PageScriptRecord.ts";
import type { RememberedValueRecord } from "./records/RememberedValueRecord.ts";
import type { ServiceCallRecord } from "./records/ServiceCallRecord.ts";
import type { StepType } from "../plan/StepType.ts";
import type { ArtifactReference } from "./ArtifactReference.ts";

// What a step that ran may leave beside its outcome, whether it passed or failed.
export type StepRecords = {
    readonly artifact?: ArtifactReference;
    readonly findings?: readonly A11yFinding[];
    // A call or backend check's record: status and response sha256, never a header or the body.
    readonly serviceCall?: ServiceCallRecord;
    // A remember step's record. An evaluate that remembers one value records it here too; one that
    // remembers several records them in rememberedValues.
    readonly remembered?: RememberedValueRecord;
    readonly rememberedValues?: readonly RememberedValueRecord[];
    // A page-script step's record: the script, how often it ran and its result's sha256, never the result.
    readonly pageScript?: PageScriptRecord;
    // A database step's record: the command, its service, exit code and output sha256, never the output.
    readonly databaseCommand?: DatabaseCommandRecord;
    // A download step's record: the file's name, media type, size and sha256, never its content.
    readonly download?: DownloadRecord;
    // An assertion's record of the stubs active while it ran, sorted by name, so a report can say it
    // checked a faked answer and not the real backend. Absent when no stub was active.
    readonly activeStubs?: readonly StubName[];
    // A frame or newTab step's record of the passed steps inside it that left a record of their own,
    // in order, each under the frame or newTab step's index. Absent when none did, so a frame of
    // plain actions and checks keeps its result, and its hash, exactly as they were. The step that
    // failed a frame or newTab step is not here: its code and records are the frame or newTab step's.
    readonly innerSteps?: readonly StepResult[];
};

// The one code a passed step may hold: a capture that took no image, since a field a secret was
// typed into could not be masked.
export type PassedStepCode = typeof StepCode.CaptureLeftOut;

export type PassedStepRecord = StepRecords & {
    readonly outcome: typeof StepOutcome.Passed;
    readonly code?: PassedStepCode;
    readonly observed?: never;
};

export type FailedStepRecord = StepRecords & {
    readonly outcome: typeof StepOutcome.Failed;
    readonly code: StepCode;
    // A redacted observation, kept only when a step fails.
    readonly observed?: string;
};

// What a step that ran holds beyond its index and type: what an executor gives back.
export type StepRecord = PassedStepRecord | FailedStepRecord;

// A step that never ran, since an earlier one failed, holds nothing but its outcome. Its other
// fields are never there, so a reader of any step's records needs no check of its outcome first.
export type SkippedStepRecord = { readonly outcome: typeof StepOutcome.Skipped } & {
    readonly [Field in keyof StepRecords | "code" | "observed"]?: never;
};

// Where a step stands in the plan: its index, and its type. A step inside a frame or newTab step
// reports under the frame or newTab step's index.
export type StepPlace = { readonly index: number; readonly type: StepType };

export type PassedStep = StepPlace & PassedStepRecord;
export type FailedStep = StepPlace & FailedStepRecord;
export type SkippedStep = StepPlace & SkippedStepRecord;

// The result of a step that ran.
export type RanStepResult = PassedStep | FailedStep;

export type StepResult = RanStepResult | SkippedStep;
