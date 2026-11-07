// Reading and logging where a failure must not reject the run. By then the steps have a verdict, or
// the run has ended before them, and a person needs the result more than anything a broken session
// or log has left to say.
import type { Logger } from "../../logging.ts";
import { errorText } from "../CodeForThrow.ts";
import { RECORD_UNREAD, recordRead, type RecordRead } from "./RecordRead.ts";

// What cannot be read goes to the log, if the log still works, and takes `otherwise`.
export function readKeepingTheResult<Value>(
    read: () => Value,
    otherwise: Value,
    logger: Logger,
): Value {
    try {
        return read();
    } catch (error) {
        logFailureAfterTheVerdict("session-records-unread", error, logger);
        return otherwise;
    }
}

// A record read from the session, or, when the read throws, unread, with the failure logged.
export function readRecord<Value>(read: () => Value, logger: Logger): RecordRead<Value> {
    try {
        return recordRead(read());
    } catch (error) {
        logFailureAfterTheVerdict("session-records-unread", error, logger);
        return RECORD_UNREAD;
    }
}

export function logFailureAfterTheVerdict(code: string, error: unknown, logger: Logger): void {
    try {
        logger.log({ kind: "step.end", outcome: "failed", code, detail: errorText(error) });
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
