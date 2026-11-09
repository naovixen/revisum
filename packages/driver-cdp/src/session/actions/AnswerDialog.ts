// A dialog step: answering the dialog the page has open.
import {
    failure,
    success,
    type ActionGuard,
    type DriverError,
    type ResolvedDialogStep,
    type Result,
} from "@revisum/contracts";
import { denialOf, NO_RESOLVED_ELEMENT } from "./ClickDenial.ts";
import { withinStep, type DocumentScope } from "../document/DocumentScope.ts";
import { normalise } from "../document/FindElements.ts";
import { pause, POLL_INTERVAL_MILLISECONDS } from "../ForAtMost.ts";
import { CRASHED } from "./WaitUntilActionable.ts";

// The text of the dialog the page has open, or opens within the timeout, or why there is none.
async function dialogText<Handle>(
    scope: DocumentScope<Handle>,
    stepDeadline: number,
): Promise<Result<string, DriverError>> {
    const { events, timeout } = scope;
    let text = events.openDialog();
    while (text === null) {
        if (events.crashed()) {
            return failure(CRASHED);
        }
        if (Date.now() >= stepDeadline) {
            return failure({ code: "not-found", detail: `no dialog opened within ${timeout} ms` });
        }
        await pause(POLL_INTERVAL_MILLISECONDS);
        text = events.openDialog();
    }
    return success(text);
}

// Answers the dialog: its text is checked first, then the guard is asked with it.
export async function answerDialog<Handle>(
    scope: DocumentScope<Handle>,
    step: ResolvedDialogStep,
    guard: ActionGuard,
): Promise<Result<void, DriverError>> {
    const stepDeadline = Date.now() + scope.timeout;
    const text = await dialogText(scope, stepDeadline);
    if (!text.ok) {
        return text;
    }
    // The dialog's text is never echoed: it may hold personal data.
    if (step.expectText !== undefined && normalise(step.expectText) !== normalise(text.value)) {
        return failure({
            code: "assertion-failed",
            detail: "the open dialog does not say the expected text",
        });
    }
    const denied = denialOf(guard(NO_RESOLVED_ELEMENT, text.value));
    if (denied !== null) {
        return failure(denied);
    }
    await withinStep(scope, stepDeadline, () =>
        scope.events.answerDialog(step.action === "accept"),
    );
    return success(undefined);
}
