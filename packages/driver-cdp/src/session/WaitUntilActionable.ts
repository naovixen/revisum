// Auto-waiting for the one element an action acts on, re-read under one deadline.
import {
    failure,
    success,
    type DriverError,
    type PageReadFailure,
    type ResolvedLocator,
    type Result,
} from "@revisum/contracts";
import { actionability } from "../in-page/Actionability.ts";
import { enabledState } from "../in-page/EnabledState.ts";
import {
    ElementEnabledState,
    type Actionability,
    type PageOperations,
    type Point,
} from "../page/PageOperations.ts";
import { locate, rethrowUnlessPassing } from "./FindElements.ts";
import {
    forAtMost,
    notAnswering,
    pause,
    POLL_INTERVAL_MILLISECONDS,
    TIMED_OUT,
} from "./ForAtMost.ts";
import { fieldsOf, reportedBoolean, reportedFields } from "./ReportedFields.ts";

export const CRASHED: PageReadFailure = {
    code: "target-crashed",
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

type ActionabilityLook<Handle> = {
    readonly count: number;
    readonly element?: Handle;
    readonly check: Actionability | null;
};

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
        return { count: found.length, check: null };
    }
    try {
        const shown = decodeActionability(
            await operations.callForString(actionability, [{ element }]),
        );
        return {
            count: 1,
            element,
            check: {
                ...shown,
                enabled: shown.attached && (await isElementEnabled(operations, element)),
            },
        };
    } catch (error) {
        rethrowUnlessPassing(error);
        // Detached during the check: locate again.
        return { count: 1, check: null };
    }
}

const REQUIRED_STATES = ["attached", "visible", "stable", "enabled", "receivesEvents"] as const;

function whyNotActionable<Handle>(
    look: ActionabilityLook<Handle>,
    timeoutMilliseconds: number,
): DriverError {
    if (look.count === 0) {
        return { code: "not-found", detail: `not-found after ${timeoutMilliseconds} ms` };
    }
    if (look.count > 1) {
        return {
            code: "ambiguous",
            detail: `${look.count} matches after ${timeoutMilliseconds} ms`,
        };
    }
    const check = look.check;
    const missing =
        check === null ? "attached" : (REQUIRED_STATES.find((state) => !check[state]) ?? "unknown");
    return { code: "not-actionable", detail: `not ${missing} after ${timeoutMilliseconds} ms` };
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
        const centre = look.check?.centre ?? null;
        const isActionable = REQUIRED_STATES.every((state) => look.check?.[state] === true);
        if (look.element !== undefined && centre !== null && isActionable) {
            return success({ element: look.element, at: centre });
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
    timeoutMilliseconds: number,
    crashed: () => boolean,
): Promise<Result<Handle, DriverError>> {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
        const found = await forAtMost(timeoutMilliseconds, locate(operations, locator));
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
                    ? { code: "not-found", detail: `not-found after ${timeoutMilliseconds} ms` }
                    : {
                          code: "ambiguous",
                          detail: `${found.length} matches after ${timeoutMilliseconds} ms`,
                      },
            );
        }
        await pause(POLL_INTERVAL_MILLISECONDS);
    }
}
