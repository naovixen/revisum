// Auto-waiting for the one element an action acts on, re-read under one deadline.
import {
    DriverErrorCode,
    ElementStateKind,
    PageReadFailureCode,
    failure,
    success,
    type DriverError,
    type PageReadFailure,
    type ResolvedLocator,
    type Result,
} from "@revisum/contracts";
import { actionability } from "../../in-page/elements/Actionability.ts";
import { enabledState } from "../../in-page/elements/EnabledState.ts";
import {
    ElementEnabledState,
    type Actionability,
    type PageOperations,
    type Point,
} from "../../page/PageOperations.ts";
import { locate, rethrowUnlessDocumentGone } from "../document/FindElements.ts";
import {
    forAtMost,
    notAnswering,
    pause,
    POLL_INTERVAL_MILLISECONDS,
    TIMED_OUT,
} from "../ForAtMost.ts";
import { fieldsOf, reportedBoolean, reportedFields } from "../document/ReportedFields.ts";

export const CRASHED: PageReadFailure = {
    code: PageReadFailureCode.TargetCrashed,
    detail: "the page's renderer died",
};

// The one rule for whether an element can be used, for a read and for an action alike. Anything
// enabledState does not say is not taken to mean enabled. Called once everything else about the
// element has been read, since a custom element's own say runs the page's code.
export async function isElementEnabled<Handle>(
    operations: PageOperations<Handle>,
    element: Handle,
): Promise<boolean> {
    const state = await operations.callForString(enabledState, [{ element }]);
    if (state === ElementEnabledState.CustomElement) {
        return operations.isCustomElementEnabled(element);
    }
    return state === ElementEnabledState.Enabled;
}

type Actionable<Handle> = Result<{ readonly element: Handle; readonly at: Point }, DriverError>;

// What one look found: not exactly one match; one match that went before it could be checked; or one
// match and how it stands.
type ActionabilityLook<Handle> =
    | { readonly kind: "not-one-match"; readonly count: number }
    | { readonly kind: "unreadable" }
    | { readonly kind: "checked"; readonly element: Handle; readonly check: Actionability };

// Decodes what actionability (in-page/Actionability.ts) reports.
function decodeActionability(text: string): Omit<Actionability, "enabled"> {
    const source = "actionability";
    const fields = reportedFields(text, source);
    const { x, y } = fieldsOf(fields["centre"]);
    return {
        attached: reportedBoolean(fields, "attached", source),
        visible: reportedBoolean(fields, "visible", source),
        stable: reportedBoolean(fields, "stable", source),
        receivesEvents: reportedBoolean(fields, "receivesEvents", source),
        centre: typeof x === "number" && typeof y === "number" ? { x, y } : null,
    };
}

async function lookForActionable<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<ActionabilityLook<Handle>> {
    const found = await locate(operations, locator);
    const element = found[0];
    if (found.length !== 1 || element === undefined) {
        return { kind: "not-one-match", count: found.length };
    }
    try {
        const shown = decodeActionability(
            await operations.callForString(actionability, [{ element }]),
        );
        return {
            kind: ElementStateKind.Checked,
            element,
            check: {
                ...shown,
                enabled: shown.attached && (await isElementEnabled(operations, element)),
            },
        };
    } catch (error) {
        rethrowUnlessDocumentGone(error);
        // The document went during the check: locate again.
        return { kind: "unreadable" };
    }
}

const REQUIRED_STATES = ["attached", "visible", "stable", "enabled", "receivesEvents"] as const;

function whyNotActionable<Handle>(
    look: ActionabilityLook<Handle>,
    timeoutMilliseconds: number,
): DriverError {
    switch (look.kind) {
        case "not-one-match":
            return look.count === 0
                ? {
                      code: DriverErrorCode.NotFound,
                      detail: `not-found after ${timeoutMilliseconds} ms`,
                  }
                : {
                      code: DriverErrorCode.Ambiguous,
                      detail: `${look.count} matches after ${timeoutMilliseconds} ms`,
                  };
        case "unreadable":
            return {
                code: DriverErrorCode.NotActionable,
                detail: `not attached after ${timeoutMilliseconds} ms`,
            };
        case "checked": {
            const missing = REQUIRED_STATES.find((state) => !look.check[state]);
            return {
                code: DriverErrorCode.NotActionable,
                detail:
                    missing === undefined
                        ? `its centre was unreadable after ${timeoutMilliseconds} ms`
                        : `not ${missing} after ${timeoutMilliseconds} ms`,
            };
        }
    }
}

// How long one wait for an element has. A look gets the whole of its limit, however little of the
// wait is left, so only a page that has stopped answering fails with timeout. Failures name the
// step's timeout.
export type ActionableWait = {
    readonly waitMilliseconds: number;
    readonly lookLimitMilliseconds: number;
    readonly stepTimeoutMilliseconds: number;
};

// Exactly one match that is attached, visible, stable, enabled and hit by a pointer at its centre.
// Never the first of several matches; a typed failure at the deadline, or at once when `crashed`
// says the page has died.
export async function waitUntilActionable<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
    wait: ActionableWait,
    crashed: () => boolean,
): Promise<Actionable<Handle>> {
    const deadline = Date.now() + wait.waitMilliseconds;
    for (;;) {
        const look = await forAtMost(
            wait.lookLimitMilliseconds,
            lookForActionable(operations, locator),
        );
        if (look === TIMED_OUT) {
            return failure(notAnswering(wait.stepTimeoutMilliseconds));
        }
        if (look.kind === "checked") {
            const { centre } = look.check;
            const isActionable = REQUIRED_STATES.every((state) => look.check[state]);
            if (centre !== null && isActionable) {
                return success({ element: look.element, at: centre });
            }
        }
        if (crashed()) {
            return failure(CRASHED);
        }
        if (Date.now() >= deadline) {
            return failure(whyNotActionable(look, wait.stepTimeoutMilliseconds));
        }
        await pause(POLL_INTERVAL_MILLISECONDS);
    }
}

// Exactly one match, attached to the page: enough for setting a file input's files, which is
// often styled out of sight behind its label.
export async function waitUntilFound<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
    wait: ActionableWait,
    crashed: () => boolean,
): Promise<Result<Handle, DriverError>> {
    const timeoutMilliseconds = wait.stepTimeoutMilliseconds;
    const deadline = Date.now() + wait.waitMilliseconds;
    for (;;) {
        const found = await forAtMost(wait.lookLimitMilliseconds, locate(operations, locator));
        if (found === TIMED_OUT) {
            return failure(notAnswering(timeoutMilliseconds));
        }
        const element = found[0];
        if (found.length === 1 && element !== undefined) {
            return success(element);
        }
        if (crashed()) {
            return failure(CRASHED);
        }
        if (Date.now() >= deadline) {
            return failure(
                found.length === 0
                    ? {
                          code: DriverErrorCode.NotFound,
                          detail: `not-found after ${timeoutMilliseconds} ms`,
                      }
                    : {
                          code: DriverErrorCode.Ambiguous,
                          detail: `${found.length} matches after ${timeoutMilliseconds} ms`,
                      },
            );
        }
        await pause(POLL_INTERVAL_MILLISECONDS);
    }
}
