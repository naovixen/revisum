// Reading and logging where a failure must not reject the run. By then the steps have a verdict, or
// the run has ended before them, and a person needs the result more than anything a broken session
// or log has left to say.
import { RunReviewItemCode, StepCode, type Result } from "@revisum/contracts";
import type { Logger } from "../logging/LoggingManifest.ts";
import { errorText } from "../CodeForThrow.ts";
import { RECORD_UNREAD, recordRead, type RecordRead } from "./RecordRead.ts";
import { EventKind } from "../logging/LoggingManifest.ts";

// The codes a failure after the verdict is logged with: a session record that could not be read, a
// session that would not close, a request decision the browser refused or an adapter that threw, and
// an egress record that could not be read.
export const FailureAfterTheVerdictCode = {
    SessionRecordsUnread: "session-records-unread",
    SessionCloseFailed: "session-close-failed",
    AdapterError: StepCode.AdapterError,
    EgressUnread: RunReviewItemCode.EgressUnread,
} as const;

export type FailureAfterTheVerdictCode =
    (typeof FailureAfterTheVerdictCode)[keyof typeof FailureAfterTheVerdictCode];

// What cannot be read goes to the log, if the log still works, and takes `otherwise`.
export function readKeepingTheResult<Value>(
    read: () => Value,
    otherwise: Value,
    logger: Logger,
): Value {
    try {
        return read();
    } catch (error) {
        logFailureAfterTheVerdict(FailureAfterTheVerdictCode.SessionRecordsUnread, error, logger);
        return otherwise;
    }
}

// A record read from the session, or, when the read throws, unread, with the failure logged.
export function readRecord<Value>(read: () => Value, logger: Logger): RecordRead<Value> {
    try {
        return recordRead(read());
    } catch (error) {
        logFailureAfterTheVerdict(FailureAfterTheVerdictCode.SessionRecordsUnread, error, logger);
        return RECORD_UNREAD;
    }
}

// A record the closed session gave, or, when it could not say, unread, with why logged.
export function closedSessionRecord<Value>(
    record: Result<Value, string>,
    logger: Logger,
): RecordRead<Value> {
    if (!record.ok) {
        logFailureAfterTheVerdict(
            FailureAfterTheVerdictCode.SessionRecordsUnread,
            record.error,
            logger,
        );
        return RECORD_UNREAD;
    }
    return recordRead(record.value);
}

export function logFailureAfterTheVerdict(
    code: FailureAfterTheVerdictCode,
    error: unknown,
    logger: Logger,
): void {
    try {
        logger.log({ kind: EventKind.StepEnd, outcome: "failed", code, detail: errorText(error) });
    } catch {
        // The log is what failed, and the result is all that is left to say it with.
    }
}

// Logs what happened where a failing log must not reject the run. True when the log took it.
export function logKeepingTheResult(event: Parameters<Logger["log"]>[0], logger: Logger): boolean {
    try {
        logger.log(event);
        return true;
    } catch {
        return false;
    }
}
