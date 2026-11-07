// The records a run reads from the session once its steps have run, and what each one left unread
// does to the verdict and the result.
import type { AppliedRewrite, StubAnswer } from "@revisum/contracts";
import { finish } from "../../lifecycle.ts";
import { EGRESS_UNREAD, UnreadRecordCode, type RunReviewItem } from "../RunResult.ts";
import type { StepsVerdict } from "../steps/VerdictOfSteps.ts";
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
    readonly code: UnreadRecordCode | typeof EGRESS_UNREAD;
}[] = [
    { record: "refusals", code: UnreadRecordCode.Refusals },
    { record: "rewrites", code: UnreadRecordCode.Rewrites },
    { record: "stubAnswers", code: UnreadRecordCode.StubAnswers },
    { record: "egress", code: EGRESS_UNREAD },
];

// A result that went on without a record would claim what nobody saw, so each record left unread
// raises a review item saying which.
export function unreadRecordItems(records: RecordsAfterTheSteps): RunReviewItem[] {
    return UNREAD_RECORD_ITEMS.flatMap(({ record, code }): RunReviewItem[] =>
        records[record].kind === RecordReadKind.Unread ? [{ code }] : [],
    );
}

// The verdict the records read before the egress leave. A run that may have tested a rewritten app
// has no verdict to give, nor has a passed run whose refusals went unread, since one refusal would
// stop it passing; a run that did not pass already says so. Unread stub answers leave the verdict
// standing.
export function verdictGivenTheRecords(
    verdict: StepsVerdict,
    records: Omit<RecordsAfterTheSteps, "egress">,
): StepsVerdict {
    const isRewriteUnknown = records.rewrites.kind === RecordReadKind.Unread;
    const isRefusalUnknown =
        records.refusals.kind === RecordReadKind.Unread && verdict.finished.state === "Passed";
    if (isRewriteUnknown || isRefusalUnknown) {
        return { ...verdict, finished: finish(verdict.running, "Errored") };
    }
    return verdict;
}
