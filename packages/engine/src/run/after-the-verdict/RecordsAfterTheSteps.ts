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

// The records read before the egress, which decide whether the refusals read late are counted.
export type RecordsBeforeTheEgress = Omit<RecordsAfterTheSteps, "egress">;

// What a record left unread raises, and whether it leaves the steps no verdict to give.
type UnreadRecordRule = {
    readonly code: UnreadRecordCode | typeof RunReviewItemCode.EgressUnread;
    losesVerdict(finished: FinishedRun): boolean;
};

// Each record's rule, in the order the result lists their review items. A run that may have tested
// a rewritten app has no verdict, nor has one whose egress went unread, which its result would
// claim; nor has a passed run whose refusals went unread, since one refusal would stop it passing,
// while a run that did not pass already says so. Unread stub answers leave the verdict standing.
const UNREAD_RECORD_RULES = {
    refusals: {
        code: UnreadRecordCode.Refusals,
        losesVerdict: (finished) => finished.state === TerminalState.Passed,
    },
    rewrites: { code: UnreadRecordCode.Rewrites, losesVerdict: () => true },
    stubAnswers: { code: UnreadRecordCode.StubAnswers, losesVerdict: () => false },
    egress: { code: RunReviewItemCode.EgressUnread, losesVerdict: () => true },
} satisfies Record<keyof RecordsAfterTheSteps, UnreadRecordRule>;

const isRecordName = (name: string): name is keyof RecordsAfterTheSteps =>
    Object.hasOwn(UNREAD_RECORD_RULES, name);

const RECORD_NAMES = Object.keys(UNREAD_RECORD_RULES).filter(isRecordName);

// The rules of the records given that were left unread, in the order the result lists them.
const unreadAmong = (records: Partial<RecordsAfterTheSteps>): UnreadRecordRule[] =>
    RECORD_NAMES.flatMap((name) =>
        records[name]?.kind === RecordReadKind.Unread ? [UNREAD_RECORD_RULES[name]] : [],
    );

// A result that went on without a record would claim what nobody saw, so each record left unread
// raises a review item saying which.
export function unreadRecordItems(records: RecordsAfterTheSteps): RunReviewItem[] {
    return unreadAmong(records).map(({ code }) => ({ code }));
}

// True when the records given, all of them or those read before the egress, leave the steps no
// verdict to give.
export function isVerdictLostToTheRecords(
    finished: FinishedRun,
    records: RecordsAfterTheSteps | RecordsBeforeTheEgress,
): boolean {
    return unreadAmong(records).some((rule) => rule.losesVerdict(finished));
}
