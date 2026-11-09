// An action in one document: the wait for its element, the runtime guard, the input, and what the
// input started.
import {
    failure,
    success,
    type ActionGuard,
    type DriverError,
    type PerformableAction,
    type ResolvedDialogStep,
    type ResolvedLocator,
    type Result,
} from "@revisum/contracts";
import { heldModifierKeys } from "../../page/input/HeldModifierKeys.ts";
import { HitCheckOutcome } from "../../page/checks/HitChecks.ts";
import { SelectOutcome, type HasStepEnded, type Point } from "../../page/PageOperations.ts";
import { answerDialog } from "./AnswerDialog.ts";
import { clickDenial, denial, guardWhileStepLasts } from "./ClickDenial.ts";
import {
    failureOfRefusedDecision,
    failureOfThrow,
    inputSettled,
    inputWithinTimeout,
    SELECTOR_INVALID,
    waitWithin,
    withinStep,
    type DocumentScope,
} from "../document/DocumentScope.ts";
import { rejectsSelector } from "../document/FindElements.ts";
import { isSecretFill, typeFill } from "./TextToFill.ts";
import { CRASHED, waitUntilActionable, waitUntilFound } from "./WaitUntilActionable.ts";

// An action on an element: every action but answering a dialog.
type ElementAction = Exclude<PerformableAction, ResolvedDialogStep>;

// What a click does with the element it found and where it will press, just before the press.
export type BeforePress<Handle> = (element: Handle, at: Point) => Promise<void>;
const NOTHING_BEFORE_PRESS = (): Promise<void> => Promise.resolve();

// A click is sent once. The wait may find a new element, and the guard is asked about the one it
// finds, just before the send. A pointer's arrival can move the element, and then no press goes:
// the wait, the guard and what comes before the press all go round again for wherever, and
// whichever, the element now is, under the step's one deadline. A press that lands on another
// element is swallowed in the page and fails the step at once: sending it again could press whatever
// the page has put there since. A press with an event that never got to the element was stopped, or
// held by a dialog, by a listener of the page's that came first, so the click did nothing, whatever
// else the page did then, such as taking the element away. The element may yet get it once a dialog
// is answered, which the step cannot wait for.
async function click<Handle>(
    scope: DocumentScope<Handle>,
    locator: ResolvedLocator,
    guard: ActionGuard,
    beforePress: BeforePress<Handle>,
    stepDeadline: number,
): Promise<Result<void, DriverError>> {
    const { operations, clickChecks } = scope;
    const crashed = (): boolean => scope.events.crashed();
    for (;;) {
        const waited = await waitUntilActionable(
            operations,
            locator,
            waitWithin(scope, stepDeadline),
            crashed,
        );
        if (!waited.ok) {
            return waited;
        }
        const { element, at } = waited.value;
        const denied = await withinStep(scope, stepDeadline, (hasStepEnded) =>
            clickDenial(operations, element, at, guardWhileStepLasts(guard, hasStepEnded)),
        );
        if (denied !== null) {
            return failure(denied);
        }
        await withinStep(scope, stepDeadline, () => beforePress(element, at));
        const hit = await inputWithinTimeout(
            scope,
            (hasStepEnded) => clickChecks.around(element, at, hasStepEnded),
            stepDeadline,
        );
        if (!hit.ok) {
            return hit;
        }
        const pressed = outcomeOfThePress(hit.value, stepDeadline, scope.timeout);
        if (pressed !== null) {
            return pressed;
        }
    }
}

// What a press's outcome means for the click, or null when it is to be aimed again.
function outcomeOfThePress(
    outcome: HitCheckOutcome,
    stepDeadline: number,
    timeout: number,
): Result<void, DriverError> | null {
    switch (outcome) {
        case HitCheckOutcome.Hit:
            return success(undefined);
        case HitCheckOutcome.Miss:
            return failure({
                code: "not-actionable",
                detail: "the click landed on another element",
            });
        case HitCheckOutcome.None:
            return failure({
                code: "not-actionable",
                detail: "no part of the press had reached the element when the step ended",
            });
        case HitCheckOutcome.NoClick:
            return failure({
                code: "not-actionable",
                detail: "the page stopped the click before it reached the element",
            });
        case HitCheckOutcome.MovedBeforeThePress:
            if (Date.now() >= stepDeadline) {
                return failure({
                    code: "not-actionable",
                    detail: `the element was still moving as the pointer reached it after ${timeout} ms, so no press was sent`,
                });
            }
            return null;
    }
}

async function upload<Handle>(
    scope: DocumentScope<Handle>,
    action: Extract<ElementAction, { readonly type: "upload" }>,
    guard: ActionGuard,
    stepDeadline: number,
): Promise<Result<void, DriverError>> {
    const { operations } = scope;
    const path = scope.details.fixturePath(action.fixture);
    if (!path.ok) {
        return path;
    }
    const found = await waitUntilFound(
        operations,
        action.locator,
        waitWithin(scope, stepDeadline),
        () => scope.events.crashed(),
    );
    if (!found.ok) {
        return found;
    }
    const denied = await withinStep(scope, stepDeadline, (hasStepEnded) =>
        denial(operations, found.value, guardWhileStepLasts(guard, hasStepEnded)),
    );
    if (denied !== null) {
        return failure(denied);
    }
    return inputWithinTimeout(
        scope,
        (hasStepEnded) => scope.clickChecks.input.setFiles(found.value, [path.value], hasStepEnded),
        stepDeadline,
    );
}

// The input of an action that is neither a click nor an upload, on the element it waited for.
async function sendInput<Handle>(
    scope: DocumentScope<Handle>,
    action: Exclude<ElementAction, { readonly type: "click" | "upload" }>,
    element: Handle,
    at: Point,
    hasStepEnded: HasStepEnded,
): Promise<Result<void, DriverError>> {
    const input = scope.clickChecks.input;
    switch (action.type) {
        case "hover":
            await input.hover(at, hasStepEnded);
            return success(undefined);
        case "fill":
            await typeFill(input, element, action.value, hasStepEnded);
            return success(undefined);
        // Enter on a form or a link starts a navigation as a click does.
        case "press":
            await input.press(
                element,
                action.key,
                heldModifierKeys(action.modifiers ?? [], process.platform),
                hasStepEnded,
            );
            return success(undefined);
        case "select": {
            const chosen = await input.select(element, action.option, hasStepEnded);
            switch (chosen) {
                case SelectOutcome.NoOption:
                    return failure({
                        code: "not-found",
                        detail: "the select has no option with that text or value",
                    });
                case SelectOutcome.NotASelect:
                    return failure({
                        code: "not-actionable",
                        detail: "the element is not a select",
                    });
                case SelectOutcome.Selected:
                    return success(undefined);
            }
        }
    }
}

// The action itself, once the step is known to be performable.
async function perform<Handle>(
    scope: DocumentScope<Handle>,
    action: ElementAction,
    guard: ActionGuard,
    beforePress: BeforePress<Handle>,
    stepDeadline: number,
): Promise<Result<void, DriverError>> {
    if (action.type === "click") {
        return click(scope, action.locator, guard, beforePress, stepDeadline);
    }
    if (action.type === "upload") {
        return upload(scope, action, guard, stepDeadline);
    }
    const { operations } = scope;
    const waited = await waitUntilActionable(
        operations,
        action.locator,
        waitWithin(scope, stepDeadline),
        () => scope.events.crashed(),
    );
    if (!waited.ok) {
        return waited;
    }
    const { element, at } = waited.value;
    const denied = await withinStep(scope, stepDeadline, (hasStepEnded) =>
        denial(operations, element, guardWhileStepLasts(guard, hasStepEnded)),
    );
    if (denied !== null) {
        return failure(denied);
    }
    // Noted before typing: a fill that fails part way may still have typed some of it.
    if (action.type === "fill" && isSecretFill(action)) {
        scope.details.secretTypedFields.push({
            locator: action.locator,
            isGone: () => operations.isElementGone(element),
        });
    }
    const sent = await inputWithinTimeout(
        scope,
        (hasStepEnded) => sendInput(scope, action, element, at, hasStepEnded),
        stepDeadline,
    );
    return sent.ok ? sent.value : sent;
}

// The element action and what it started to show, within the step's timeout.
async function performAndSettle<Handle>(
    scope: DocumentScope<Handle>,
    action: ElementAction,
    guard: ActionGuard,
    beforePress: BeforePress<Handle>,
    stepDeadline: number,
): Promise<Result<void, DriverError>> {
    const acted = await perform(scope, action, guard, beforePress, stepDeadline);
    if (!acted.ok) {
        return acted;
    }
    const settled = await inputWithinTimeout(scope, () => inputSettled(scope), stepDeadline);
    return settled.ok ? acted : settled;
}

// An action, with `beforePress` run just before a click's press. Whatever the action found, a page
// that died, a request decision the browser refused or a popup, second page or download the step
// started is its failure, except a denial, which the audit log holds.
export async function actBeforePress<Handle>(
    scope: DocumentScope<Handle>,
    action: PerformableAction,
    guard: ActionGuard,
    beforePress: BeforePress<Handle>,
): Promise<Result<void, DriverError>> {
    const { events } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const alreadyRefused = failureOfRefusedDecision(scope, "not-actionable");
    if (alreadyRefused !== null) {
        return failure(alreadyRefused);
    }
    if (action.type === "dialog") {
        try {
            return await answerDialog(scope, action, guard);
        } catch (error) {
            return failure(failureOfThrow(scope, error));
        }
    }
    const openingsBefore = events.unsupportedOpenings();
    const stepDeadline = Date.now() + scope.timeout;
    let acted: Result<void, DriverError>;
    try {
        const isRejected = await withinStep(scope, stepDeadline, () =>
            rejectsSelector(scope.operations, action.locator),
        );
        if (isRejected) {
            return failure(SELECTOR_INVALID);
        }
        acted = await performAndSettle(scope, action, guard, beforePress, stepDeadline);
    } catch (error) {
        acted = failure(failureOfThrow(scope, error));
    }
    // The audit log holds this denial, so nothing noticed in the same moment may take its place.
    if (!acted.ok && acted.error.code === "policy-denied") {
        return acted;
    }
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const refused = failureOfRefusedDecision(scope, "not-actionable");
    if (refused !== null) {
        return failure(refused);
    }
    if (events.unsupportedOpenings() > openingsBefore) {
        return failure({
            code: "unsupported-step",
            detail: "the step opened a popup or a second page, or started a download",
        });
    }
    return acted;
}

export const actOnDocument = <Handle>(
    scope: DocumentScope<Handle>,
    action: PerformableAction,
    guard: ActionGuard,
): Promise<Result<void, DriverError>> => actBeforePress(scope, action, guard, NOTHING_BEFORE_PRESS);
