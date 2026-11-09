// The elements a locator matches in one document.
import {
    StructuralLocatorKind,
    SemanticLocatorKind,
    DEFAULT_TEST_ID_ATTRIBUTE,
    type Position,
    type ResolvedLocator,
} from "@revisum/contracts";
import {
    findByLabel,
    findByTestId,
    findByText,
    findStructural,
    inDocumentOrder,
} from "../../in-page/elements/FindByLabel.ts";
import { inThisDocument } from "../../in-page/elements/ProbeElement.ts";
import { structuralSelectorValidity } from "../../in-page/elements/StructuralSelectorValidity.ts";
import { DocumentGone } from "../../page/failures/DocumentGone.ts";
import type { PageOperations } from "../../page/PageOperations.ts";
import { isDocumentGone } from "../../page/failures/LostObject.ts";

// White space collapsed, as the browser compares accessible names and as a dialog's text is read.
export const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

// Lets a catch read a failed look at the page as "nothing yet" only when the document it asked went
// away, as one navigating does, which says nothing of what was in it. Anything else, such as a dialog,
// a reply the browser garbled, a command that ran out of time or a driver bug, is no element missing.
export function rethrowUnlessDocumentGone(error: unknown): void {
    if (!isDocumentGone(error)) {
        throw error;
    }
}

// The elements a locator matches. Throws when the page cannot answer, which says nothing about
// what is on it.
export async function findElements<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<Handle[]> {
    const found = await matches(operations, locator);
    return locator.position === undefined ? found : atPosition(operations, found, locator.position);
}

// The elements a locator matches, or null when the document it was asked of has gone, which says
// nothing of what was in it. Any other failure says more than that, so it goes on up.
export async function findElementsUnlessDocumentGone<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<Handle[] | null> {
    try {
        return await findElements(operations, locator);
    } catch (error) {
        if (error instanceof DocumentGone) {
            return null;
        }
        throw error;
    }
}

// For an action, which only waits for an element to act on: a document that goes while the page
// navigates counts as "nothing found yet". A check reads through findElements, since finding nothing can pass it.
export async function locate<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<Handle[]> {
    try {
        return await findElements(operations, locator);
    } catch (error) {
        rethrowUnlessDocumentGone(error);
        return [];
    }
}

async function matches<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<Handle[]> {
    switch (locator.by) {
        // The browser compares names with their white space collapsed, so a plan's name must be too.
        case SemanticLocatorKind.Role:
            return ownElements(
                operations,
                await operations.byRole(locator.role, normalise(locator.name)),
            );
        case SemanticLocatorKind.Label:
            return operations.callForElements(findByLabel, [locator.label]);
        case SemanticLocatorKind.Text:
            return operations.callForElements(findByText, [locator.text]);
        case SemanticLocatorKind.TestId:
            return operations.callForElements(findByTestId, [
                locator.testId,
                locator.attribute ?? DEFAULT_TEST_ID_ATTRIBUTE,
            ]);
        case StructuralLocatorKind.Css:
        case StructuralLocatorKind.Xpath: {
            // Inside another locator, the selector is evaluated in the one element that one finds, or
            // nowhere.
            const scope =
                locator.inside === undefined ? [] : await findElements(operations, locator.inside);
            if (locator.inside !== undefined && scope.length !== 1) {
                return [];
            }
            const text =
                locator.by === StructuralLocatorKind.Css ? locator.selector : locator.expression;
            return operations.callForElements(findStructural, [
                locator.by,
                text,
                locator.hasText ?? "",
                ...scope.map((element) => ({ element })),
            ]);
        }
    }
}

// What structuralSelectorValidity says.
const SelectorValidity = { Valid: "valid", Invalid: "invalid" } as const;

// True when the browser rejects a CSS selector or XPath expression of the locator or of a locator
// it is inside. A document that went while it was asked, as one navigating does, is taken to accept
// it: matching then finds nothing yet, as for any locator.
export async function rejectsSelector<Handle>(
    operations: PageOperations<Handle>,
    locator: ResolvedLocator,
): Promise<boolean> {
    if (locator.by !== StructuralLocatorKind.Css && locator.by !== StructuralLocatorKind.Xpath) {
        return false;
    }
    const text = locator.by === StructuralLocatorKind.Css ? locator.selector : locator.expression;
    let validity: string = SelectorValidity.Valid;
    try {
        validity = await operations.callForString(structuralSelectorValidity, [locator.by, text]);
    } catch (error) {
        rethrowUnlessDocumentGone(error);
    }
    if (validity === SelectorValidity.Invalid) {
        return true;
    }
    return locator.inside !== undefined && rejectsSelector(operations, locator.inside);
}

function indexAtPosition(position: Position, matchCount: number): number {
    if (position === "first") {
        return 0;
    }
    return position === "last" ? matchCount - 1 : position - 1;
}

// The one match at the position, counted in document order, or none when there are fewer matches.
// The browser's accessibility search and the label search do not promise document order, so the
// matches are sorted in the page first.
async function atPosition<Handle>(
    operations: PageOperations<Handle>,
    found: readonly Handle[],
    position: Position,
): Promise<Handle[]> {
    const ordered =
        found.length < 2
            ? [...found]
            : await operations.callForElements(
                  inDocumentOrder,
                  found.map((element) => ({ element })),
              );
    const picked = ordered[indexAtPosition(position, ordered.length)];
    return picked === undefined ? [] : [picked];
}

// The browser's accessibility search may reach into the frames of a document; a locator matches
// only the document it was given.
async function ownElements<Handle>(
    operations: PageOperations<Handle>,
    found: readonly Handle[],
): Promise<Handle[]> {
    const own: Handle[] = [];
    for (const element of found) {
        if ((await operations.callForString(inThisDocument, [{ element }])) === "yes") {
            own.push(element);
        }
    }
    return own;
}
