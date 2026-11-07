import type { SuitePass } from "../evidence-mode.ts";
import type { EvidenceOutcomeCode } from "./EvidenceOutcomeCode.ts";
import type { SuiteDecodeError } from "./SuiteDecodeError.ts";

// What only an evidence run records: which pass it was, the suite command's exit code, and whether
// that code disagreed with the outcomes the report gives, which makes the run Errored. The outcome
// code and decode errors are present only when there are some, so other results stay as they were.
export type EvidenceRunRecord = {
    readonly pass: SuitePass;
    readonly exitCode: number;
    readonly exitCodeMismatch: boolean;
    readonly outcomeCode?: EvidenceOutcomeCode;
    // Codes and JSON paths only, never a value from the suite's output.
    readonly decodeErrors?: readonly SuiteDecodeError[];
};
