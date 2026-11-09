// The codes a step fails with when something other than its own check stopped it: a throw, a read
// of the page that gave nothing, or a capture that could not be taken. The text of what went wrong
// goes only to the log, which redacts it, never into the result.
import {
    PageReadFailureCode,
    StepCode,
    type DocumentSession,
    type DriverError,
    type DriverErrorCode,
    type PageReadFailure,
} from "@revisum/contracts";
import type { Logger } from "./logging/LoggingManifest.ts";
import { EventKind } from "./logging/LoggingManifest.ts";

export const errorText = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 200);

// The code for something that threw. A read of the page says what stopped it and never throws, but
// a throw from anything else cannot say the page died.
export function codeForThrow(error: unknown, document: DocumentSession, logger: Logger): StepCode {
    const code = document.crashed() ? StepCode.TargetCrashed : StepCode.AdapterError;
    logger.log({ kind: EventKind.StepEnd, outcome: "failed", code, detail: errorText(error) });
    return code;
}

// What a step fails with when a read of the page gave nothing. A dialog and a crash are the page's to
// answer for. A read that gave nothing for any other reason is the adapter's.
const STEP_CODE_OF_FAILED_READ = {
    [PageReadFailureCode.DialogOpen]: StepCode.DialogOpen,
    [PageReadFailureCode.TargetCrashed]: StepCode.TargetCrashed,
    [PageReadFailureCode.PageUnreadable]: StepCode.AdapterError,
} as const satisfies Record<PageReadFailureCode, StepCode>;
type FailedReadCode = (typeof STEP_CODE_OF_FAILED_READ)[PageReadFailureCode];

// The adapter's own failure keeps its text, which goes only to the log.
export function codeOfFailedRead(readFailure: PageReadFailure, logger: Logger): FailedReadCode {
    const code = STEP_CODE_OF_FAILED_READ[readFailure.code];
    if (code === StepCode.AdapterError) {
        logger.log({ kind: EventKind.StepEnd, outcome: "failed", code, detail: readFailure.detail });
    }
    return code;
}

const PAGE_READ_FAILURE_CODES: readonly DriverErrorCode[] = Object.values(PageReadFailureCode);
const isPageReadFailure = (error: DriverError): error is PageReadFailure =>
    PAGE_READ_FAILURE_CODES.includes(error.code);

// A capture fails as a read of the page does, or with the code the driver gave for anything else,
// such as a field a secret was typed into that it could not find to hide.
export const codeOfFailedCapture = (error: DriverError, logger: Logger): StepCode =>
    isPageReadFailure(error) ? codeOfFailedRead(error, logger) : error.code;
