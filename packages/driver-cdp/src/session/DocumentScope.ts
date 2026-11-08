// What every port of one document works with, and the rules they share for time and failure.
import {
    failure,
    success,
    type DriverError,
    type DriverErrorCode,
    type PageReadFailure,
    type Result,
    type SessionEnvironment,
} from "@revisum/contracts";
import { isCommandTimeout } from "../connection/CdpError.ts";
import { errorText } from "../connection/ErrorText.ts";
import type { CheckedDocument, HitChecks } from "../page/HitChecks.ts";
import type { PageEvents } from "../page/PageEvents.ts";
import type { HasStepEnded, PageOperations } from "../page/PageOperations.ts";
import { PageHeldByDialog } from "../page/PageHeldByDialog.ts";
import {
    inputForAtMost,
    notAnswering,
    SHORTEST_INPUT_MILLISECONDS,
    StepOutOfTime,
    TIMED_OUT,
} from "./ForAtMost.ts";
import type { DocumentDetails } from "./SessionDetails.ts";
import { CRASHED, type ActionableWait } from "./WaitUntilActionable.ts";

// `masked` lists the documents a screenshot masks: this one and every document it is framed in, so a
// capture from inside a frame hides what the top page hides. The first of them is the top document.
// Input goes only through `clickChecks`.
export type DocumentScope<Handle> = {
    readonly operations: PageOperations<Handle>;
    readonly clickChecks: HitChecks<Handle>;
    readonly masked: readonly PageOperations<Handle>[];
    // The tab's top document with its checks: a mask hides what any document framed in it shows.
    readonly topDocument: CheckedDocument<Handle>;
    readonly environment: SessionEnvironment;
    readonly details: DocumentDetails;
    readonly events: PageEvents;
    // The step timeout.
    readonly timeout: number;
};

export const DIALOG_OPEN: PageReadFailure = {
    code: "dialog-open",
    detail: "a dialog is open: a dialog step must answer it first",
};
export const SELECTOR_INVALID: DriverError = {
    code: "selector-invalid",
    detail: "the browser rejects a CSS selector or XPath expression of the locator",
};

export const isTopDocument = <Handle>(scope: DocumentScope<Handle>): boolean =>
    scope.masked.length === 1;

// A refusal the session holds, from whenever it came, as the failure of what is under way.
export function failureOfRefusedDecision<Handle>(
    scope: DocumentScope<Handle>,
    code: DriverErrorCode,
): DriverError | null {
    const [refusal] = scope.events.refusedRequestDecisions();
    return refusal === undefined ? null : { code, detail: refusal };
}

// A step has one timeout, whatever it spent the time on, so input gets what the wait for the element
// left of it. The step ends when that runs out, whatever the input is still doing. Every input of a
// step goes through here, so none is sent once its step has ended.
export async function inputWithinTimeout<Handle, Value>(
    scope: DocumentScope<Handle>,
    send: (hasStepEnded: HasStepEnded) => Promise<Value>,
    stepDeadline: number,
): Promise<Result<Value, DriverError>> {
    const ended = await inputForAtMost(timeForTheStep(scope, stepDeadline), send);
    return ended === TIMED_OUT
        ? failure({
              code: "timeout",
              detail: `the input was still being handled after ${scope.timeout} ms`,
          })
        : success(ended);
}

// What is left of the step's one timeout, as a read or an input gets it: long enough to be answered
// however late it came, or a page that only has its hands full would read as one that has stopped.
function timeForTheStep<Handle>(scope: DocumentScope<Handle>, stepDeadline: number): number {
    return Math.max(
        stepDeadline - Date.now(),
        Math.min(SHORTEST_INPUT_MILLISECONDS, scope.timeout),
    );
}

// What a step asks the page, under the step's one deadline, whatever it is asking. It throws
// StepOutOfTime once that has passed; what was asked for is left to end by itself, and is told, through
// `hasStepEnded`, once it is too late to act on what it reads.
export async function withinStep<Handle, Value>(
    scope: DocumentScope<Handle>,
    stepDeadline: number,
    ask: (hasStepEnded: HasStepEnded) => Promise<Value>,
): Promise<Value> {
    const answered = await inputForAtMost(timeForTheStep(scope, stepDeadline), ask);
    if (answered === TIMED_OUT) {
        throw new StepOutOfTime(notAnswering(scope.timeout).detail);
    }
    return answered;
}

// What is left of a step's one timeout, for a wait inside it. A look at a page still gets long enough
// to be answered, as input does, or a page that only has its hands full would read as one that has
// stopped.
export function waitWithin<Handle>(
    scope: DocumentScope<Handle>,
    stepDeadline: number,
): ActionableWait {
    const left = Math.max(stepDeadline - Date.now(), 0);
    return {
        waitMilliseconds: left,
        lookLimitMilliseconds: Math.max(left, Math.min(SHORTEST_INPUT_MILLISECONDS, scope.timeout)),
        stepTimeoutMilliseconds: scope.timeout,
    };
}

// Waits for what an input started to show. A navigation it started has its effect only once it
// arrives, however long the old page goes on answering, and one that turns out to be a download
// ends a moment before the browser says so.
export async function inputSettled<Handle>(scope: DocumentScope<Handle>): Promise<void> {
    await scope.operations.twoFramesLater();
    await scope.events.navigationEnded();
    await scope.operations.twoFramesLater();
}

// A dead page says so before a dialog does. The dialog may have opened since the read began, and
// what then stopped the read need not be the dialog's own signal, such as a read out of time.
export function failureOfRead<Handle>(
    scope: DocumentScope<Handle>,
    error: unknown,
): PageReadFailure {
    if (scope.events.crashed()) {
        return CRASHED;
    }
    if (error instanceof PageHeldByDialog || scope.events.openDialog() !== null) {
        return DIALOG_OPEN;
    }
    return { code: "page-unreadable", detail: errorText(error) };
}

// A read of the page never rejects: every signal the page's commands give ends here, as its failure.
export async function readOfPage<Handle, Value>(
    scope: DocumentScope<Handle>,
    read: () => Promise<Value>,
): Promise<Result<Value, PageReadFailure>> {
    try {
        return success(await read());
    } catch (error) {
        return failure(failureOfRead(scope, error));
    }
}

// A read with its own step's one deadline, for a read that asks the page one thing.
export const readWithinStep = <Handle, Value>(
    scope: DocumentScope<Handle>,
    read: () => Promise<Value>,
): Promise<Result<Value, PageReadFailure>> =>
    readOfPage(scope, () => withinStep(scope, Date.now() + scope.timeout, read));

// A command the browser never answered says nothing about the element or the frame it was for.
export function failureOfThrow<Handle>(scope: DocumentScope<Handle>, error: unknown): DriverError {
    if (error instanceof PageHeldByDialog) {
        return DIALOG_OPEN;
    }
    if (scope.events.crashed()) {
        return CRASHED;
    }
    return {
        code:
            isCommandTimeout(error) || error instanceof StepOutOfTime
                ? "timeout"
                : "not-actionable",
        detail: errorText(error),
    };
}
