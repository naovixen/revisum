// The records a run reads from the session once its steps have run, and what each one left unread
// does to the verdict and the result.
import {
    type AppliedRewrite,
    type StubAnswer,
    RunReviewItemCode,
    TerminalState,
    UnreadRecordCode,
    type RunReviewItem,
} from "@revisum/contracts";
import type { FinishedRun } from "../steps/VerdictOfSteps.ts";
import { RecordReadKind, type RecordRead } from "./RecordRead.ts";

export type RecordsAfterTheSteps = {
    // The request decisions the browser refused, read once the session has closed.
    readonly refusals: RecordRead<readonly string[]>;
    // What the egress proxy rewrote.
    readonly rewrites: RecordRead<readonly AppliedRewrite[]>;
    // Which stubs answered.
    readonly stubAnswers: RecordRead<readonly StubAnswer[]>;
    // The origins the egress refused, read after the cleanup.
    readonly egress: RecordRead<readonly string[]>;
};

// Each record's review item, in the order the result lists them.
const UNREAD_RECORD_ITEMS: readonly {
    readonly record: keyof RecordsAfterTheSteps;
    readonly code: UnreadRecordCode | typeof RunReviewItemCode.EgressUnread;
}[] = [
    { record: "refusals", code: UnreadRecordCode.Refusals },
    { record: "rewrites", code: UnreadRecordCode.Rewrites },
    { record: "stubAnswers", code: UnreadRecordCode.StubAnswers },
    { record: "egress", code: RunReviewItemCode.EgressUnread },
];

// A result that went on without a record would claim what nobody saw, so each record left unread
// raises a review item saying which.
export function unreadRecordItems(records: RecordsAfterTheSteps): RunReviewItem[] {
    return UNREAD_RECORD_ITEMS.flatMap(({ record, code }): RunReviewItem[] =>
        records[record].kind === RecordReadKind.Unread ? [{ code }] : [],
    );
}

// True when the records read before the egress leave the steps no verdict to give. A run that may
// have tested a rewritten app has none, nor has a passed run whose refusals went unread, since one
// refusal would stop it passing; a run that did not pass already says so. Unread stub answers leave
// the verdict standing.
export function isVerdictLostToTheRecords(
    finished: FinishedRun,
    records: Omit<RecordsAfterTheSteps, "egress">,
): boolean {
    const isRewriteUnknown = records.rewrites.kind === RecordReadKind.Unread;
    const isRefusalUnknown =
        records.refusals.kind === RecordReadKind.Unread && finished.state === TerminalState.Passed;
    return isRewriteUnknown || isRefusalUnknown;
}
