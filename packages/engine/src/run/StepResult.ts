// What a run keeps of each step it ran.
import type {
    A11yFinding,
    ArtifactReference,
    DownloadName,
    Step,
    StepCode,
    StepOutcome,
    StubName,
    ValueName,
} from "@revisum/contracts";
import type { DatabaseCommandRecord } from "../database-commands/database-command-steps.ts";
import type { PageScriptRecord } from "../page-scripts/page-script-steps.ts";
import type { ServiceCallRecord } from "../service-calls/call-steps.ts";

export type StepResult = {
    readonly index: number;
    readonly type: Step["type"];
    readonly outcome: StepOutcome;
    readonly code?: StepCode;
    // A redacted observation, kept only when a step fails.
    readonly observed?: string;
    readonly artifact?: ArtifactReference;
    readonly findings?: readonly A11yFinding[];
    // A call or backend check's record: status and response sha256, never a header or the body.
    readonly serviceCall?: ServiceCallRecord;
    // A remember step's record: the value's name and the sha256 of its text, never the text. An
    // evaluate that remembers one value records it here too; one that remembers several records
    // them in rememberedValues.
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

export type RememberedValueRecord = { readonly valueName: ValueName; readonly sha256: string };
// What a run keeps of a downloaded file. The server's name and media type are kept redacted; the
// content is never kept (until privacy masking, whatever evidence.keepDownloads says).
export type DownloadRecord = {
    readonly downloadName: DownloadName;
    readonly fileName: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
};

// Something a run found that a person should look at, whatever the verdict: a cleanup call that
// failed, so test data may be left behind; or a suite test's criterion annotation whose
