// What the policy gate's runtime guard is asked about an action's element, and its denial.
import type { ActionGuard, DriverError, GuardVerdict, ResolvedElement } from "@revisum/contracts";
import { whatAClickActivates } from "../in-page/Actionability.ts";
import { guardDetails } from "../in-page/GuardDetails.ts";
import type { PageOperations, Point } from "../page/PageOperations.ts";
import { boxOf, fieldsOf } from "./ReportedFields.ts";

// What the runtime guard is told for a dialog step, which acts on no element.
export const NO_RESOLVED_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

// Decodes what guardDetails (in-page/GuardDetails.ts) reports. A field of another shape is read as
// not shown.
function decodeGuardDetails(text: string): Omit<ResolvedElement, "role" | "name"> {
    const fields = fieldsOf(JSON.parse(text));
    const testId = textOrNull(fields["testId"]);
    return {
        box: boxOf(fields["box"]),
        formSubmitName: textOrNull(fields["formSubmitName"]),
        linkUrl: textOrNull(fields["linkUrl"]),
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

// A denial as the step's error, or null for an allow.
export function denialOf(verdict: GuardVerdict): DriverError | null {
    return verdict.kind === "deny"
        ? { code: "policy-denied", detail: `denied by the ${verdict.rule} rule` }
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
