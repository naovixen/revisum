// Whether a field a secret was typed into can be left out of a screenshot's masks.
import { isDeepStrictEqual } from "node:util";
import type { ResolvedLocator } from "@revisum/contracts";
import { fieldValues } from "../in-page/MaskElements.ts";
import type { PageOperations } from "../page/PageOperations.ts";
import { rethrowUnlessDocumentGone } from "./FindElements.ts";
import type { SecretTypedField } from "./SessionDetails.ts";

// True when every element a secret was typed into under this locator has gone. One the session has
// no record of, or one that cannot say, counts as still there.
export async function hasTypedFieldGone(
    typedFields: readonly SecretTypedField[],
    locator: ResolvedLocator,
): Promise<boolean> {
    const typed = typedFields.filter((field) => isDeepStrictEqual(field.locator, locator));
    try {
        const gone = await Promise.all(typed.map((field) => field.isGone()));
        return typed.length > 0 && gone.every(Boolean);
    } catch (error) {
        rethrowUnlessDocumentGone(error);
        return false;
    }
}

// Decodes what fieldValues (in-page/MaskElements.ts) reports. A page's own scripts may have changed
// what the browser hands back, so a list of another shape throws, and that shows nothing either way.
function decodeFieldValues(text: string): readonly string[] {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
        throw new TypeError("the page did not report its fields as a list");
    }
    return parsed.filter((value): value is string => typeof value === "string");
}

// True when some field in the documents holds a secret: a page may render a field afresh under
// another label, still holding what was typed, and no locator finds that one.
export async function hasFieldHoldingASecret<Handle>(
    documents: readonly PageOperations<Handle>[],
    holdsSecret: (text: string) => boolean,
): Promise<boolean> {
    for (const document of documents) {
        if (decodeFieldValues(await document.callForString(fieldValues, [])).some(holdsSecret)) {
            return true;
        }
    }
    return false;
}
