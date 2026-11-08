// A page script, raced against its timeout in real time. A script that never settles is left to the
// page: the run ends without it, and closing the session ends the page. One not yet called when the
// time runs out, such as behind a page that holds the driver's own calls, is never called.
import {
    failure,
    success,
    type DriverError,
    type PageScriptCall,
    type Result,
} from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";
import { PageHeldByDialog } from "../page/PageHeldByDialog.ts";
import type { ScriptCallOutcome } from "../page/PageOperations.ts";
import { DIALOG_OPEN, type DocumentScope } from "./DocumentScope.ts";
import { inputForAtMost, TIMED_OUT } from "./ForAtMost.ts";
import { CRASHED } from "./WaitUntilActionable.ts";

function resultOfTheScript(ended: ScriptCallOutcome): Result<string, DriverError> {
    switch (ended.kind) {
        case "result":
            return success(ended.text);
        case "threw":
            return failure({
                code: "script-failed",
                detail: "the script threw or its promise was rejected",
            });
        case "not-json":
            return failure({
                code: "script-result-invalid",
                detail: "the script's result is not a value JSON can write",
            });
    }
}

export async function runPageScript<Handle>(
    scope: DocumentScope<Handle>,
    call: PageScriptCall,
): Promise<Result<string, DriverError>> {
    const { events } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const openingsBefore = events.unsupportedOpenings();
    let ended: ScriptCallOutcome | typeof TIMED_OUT;
    try {
        ended = await inputForAtMost(call.timeoutMilliseconds, (hasStepEnded) =>
            scope.clickChecks.input.callScript(
                call.source,
                call.arguments,
                call.maximumResultBytes,
                hasStepEnded,
            ),
        );
    } catch (error) {
        if (error instanceof PageHeldByDialog) {
            return failure(DIALOG_OPEN);
        }
        return failure(
            events.crashed() ? CRASHED : { code: "script-failed", detail: errorText(error) },
        );
    }
    if (events.crashed()) {
        return failure(CRASHED);
    }
    if (ended === TIMED_OUT) {
        return failure({
            code: "script-timeout",
            detail: `the script did not settle within ${call.timeoutMilliseconds} ms`,
        });
    }
    // A popup, second page or download the script started is closed or cancelled, as for an action.
    if (events.unsupportedOpenings() > openingsBefore) {
        return failure({
            code: "unsupported-step",
            detail: "the script opened a popup or a second page, or started a download",
        });
    }
    return resultOfTheScript(ended);
}
