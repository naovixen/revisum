// What the policy gate's runtime guard is asked about an action's element, and its denial.
import type { ActionGuard, DriverError, GuardVerdict, ResolvedElement } from "@revisum/contracts";
import { whatAClickActivates } from "../../in-page/elements/Actionability.ts";
import { guardDetails } from "../../in-page/elements/GuardDetails.ts";
import type { HasStepEnded, PageOperations, Point } from "../../page/PageOperations.ts";
import { StepHasEnded } from "../../page/failures/StepHasEnded.ts";
import {
    reportedBoxOrNull,
    reportedFields,
    reportedTextOrNull,
} from "../document/ReportedFields.ts";
import { DriverErrorCode, PolicyVerdictKind } from "@revisum/contracts";

// What the runtime guard is told for a dialog step, which acts on no element.
export const NO_RESOLVED_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};

// Decodes what guardDetails (in-page/GuardDetails.ts) reports. A field of another shape says the report
// cannot be trusted: reading it as "not shown" would have the guard judge what the page failed to say.
function decodeGuardDetails(text: string): Omit<ResolvedElement, "role" | "name"> {
    const source = "guardDetails";
    const fields = reportedFields(text, source);
    const testId = reportedTextOrNull(fields, "testId", source);
    return {
        box: reportedBoxOrNull(fields, "box", source),
        formSubmitName: reportedTextOrNull(fields, "formSubmitName", source),
        linkUrl: reportedTextOrNull(fields, "linkUrl", source),
        ...(testId === null ? {} : { testId }),
    };
}

// The element as the runtime guard sees it.
async function resolvedElement<Handle>(
    operations: PageOperations<Handle>,
    element: Handle,
): Promise<ResolvedElement> {
    const { role, name } = await operations.roleAndName(element);
    return {
        role,
        name,
        ...decodeGuardDetails(await operations.callForString(guardDetails, [{ element }])),
    };
}

// The guard, for a read a step's deadline may outlive: once the step has ended, the read goes no
// further than asking, so no verdict is recorded for a step that has already failed.
export const guardWhileStepLasts =
    (guard: ActionGuard, hasStepEnded: HasStepEnded): ActionGuard =>
    (element, dialogText) => {
        if (hasStepEnded()) {
            throw new StepHasEnded("the runtime guard");
        }
        return guard(element, dialogText);
    };

// A denial as the step's error, or null for an allow.
export function denialOf(verdict: GuardVerdict): DriverError | null {
    return verdict.kind === PolicyVerdictKind.Deny
        ? { code: DriverErrorCode.PolicyDenied, detail: `denied by the ${verdict.rule} rule` }
        : null;
}

// Asks the guard about the resolved element. A denial is the step's error.
export async function denial<Handle>(
    operations: PageOperations<Handle>,
    element: Handle,
    guard: ActionGuard,
): Promise<DriverError | null> {
    return denialOf(guard(await resolvedElement(operations, element), null));
}

const isUnnamed = (element: ResolvedElement): boolean =>
    element.name === null || element.name.trim() === "";

// Asks the guard about a click at the point: the element found, then what the click would really
// act on, since a press goes to whatever is under the pointer and on to the control around it. A
// wrapper's or an icon's harmless name must not stand in for that control's. Most of what a pointer
// lands on has no name of its own, which says nothing against the plan's element, so such an
// element is judged only on the link it leads to, under the name of the element found.
export async function clickDenial<Handle>(
    operations: PageOperations<Handle>,
    element: Handle,
    at: Point,
    guard: ActionGuard,
): Promise<DriverError | null> {
    const found = await resolvedElement(operations, element);
    const denied = denialOf(guard(found, null));
    if (denied !== null) {
        return denied;
    }
    const activatedElements = await operations.callForElements(whatAClickActivates, [
        { element },
        at.x,
        at.y,
    ]);
    for (const activated of activatedElements) {
        const seen = await resolvedElement(operations, activated);
        if (isUnnamed(seen) && (seen.linkUrl === null || seen.linkUrl === found.linkUrl)) {
            continue;
        }
        const judged = isUnnamed(seen) ? { ...found, linkUrl: seen.linkUrl } : seen;
        const activatedDenial = denialOf(guard(judged, null));
        if (activatedDenial !== null) {
            return activatedDenial;
        }
    }
    return null;
}
