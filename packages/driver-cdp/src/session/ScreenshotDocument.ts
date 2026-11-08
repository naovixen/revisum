// Screenshots of one document's viewport, with what must stay hidden painted solid black.
import {
    failure,
    success,
    type DriverError,
    type PageReadFailure,
    type ResolvedLocator,
    type Result,
} from "@revisum/contracts";
import {
    fontsReady,
    framedDocumentElements,
    maskElements,
    maskGivenElements,
    unmaskElements,
} from "../in-page/MaskElements.ts";
import type { CheckedDocument } from "../page/HitChecks.ts";
import type { PageOperations } from "../page/PageOperations.ts";
import { failureOfRead, readWithinStep, type DocumentScope } from "./DocumentScope.ts";
import { findElementsUnlessDocumentGone } from "./FindElements.ts";
import { forAtMost, notAnswering, TIMED_OUT } from "./ForAtMost.ts";
import { hasFieldHoldingASecret, hasTypedFieldGone } from "./HasTypedFieldGone.ts";

// Every document framed in this one, however deep, found through the browser. A frame the driver
// cannot reach, such as one whose document runs in another process, cannot be masked, so the capture
// fails rather than show what it may hold.
async function framedDocumentsIn<Handle>(
    framing: CheckedDocument<Handle>,
): Promise<PageOperations<Handle>[]> {
    const frames = await framing.operations.callForElements(framedDocumentElements, []);
    const found: PageOperations<Handle>[] = [];
    for (const frame of frames) {
        const inner = await framing.checks.frame(frame);
        if (inner === null) {
            throw new Error("a framed document cannot be reached, so the masks cannot hide it");
        }
        found.push(inner.operations, ...(await framedDocumentsIn(inner)));
    }
    return found;
}

// The documents a mask must reach: the top document and all it frames, since what a mask hides may sit
// in any of them. With nothing to mask no frame matters, and those not yet masked are left alone.
async function documentsToMask<Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
): Promise<readonly PageOperations<Handle>[]> {
    if (mask.length === 0) {
        return scope.masked;
    }
    return [scope.topDocument.operations, ...(await framedDocumentsIn(scope.topDocument))];
}

// What masks paint before the viewport is captured, then take away.
async function maskedScreenshot<Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
    paintBesides: () => Promise<void>,
): Promise<Uint8Array> {
    await scope.operations.callForString(fontsReady, []);
    const documents = await documentsToMask(scope, mask);
    for (const document of documents) {
        await document.callForString(maskElements, [mask]);
    }
    try {
        await paintBesides();
        return await scope.operations.screenshotPng();
    } finally {
        for (const document of documents) {
            await document.callForString(unmaskElements, []);
        }
    }
}

export const screenshotDocument = <Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
): Promise<Result<Uint8Array, PageReadFailure>> =>
    readWithinStep(scope, () => maskedScreenshot(scope, mask, () => Promise.resolve()));

type ElementsToPaint<Handle> = {
    readonly framed: PageOperations<Handle>;
    readonly elements: readonly Handle[];
};

async function screenshotWithFieldsHidden<Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
    fields: readonly ResolvedLocator[],
    holdsSecret: (text: string) => boolean,
): Promise<Result<Uint8Array, DriverError>> {
    // True when a field no locator finds has gone, and what was typed into it with it.
    const canBeLeftUnmasked = async (field: ResolvedLocator): Promise<boolean> =>
        (await hasTypedFieldGone(scope.details.secretTypedFields, field)) &&
        !(await hasFieldHoldingASecret(scope.masked, holdsSecret));
    const toPaint: ElementsToPaint<Handle>[] = [];
    for (const field of fields) {
        let isFound = false;
        let isEveryDocumentRead = true;
        for (const framed of scope.masked) {
            const elements = await findElementsUnlessDocumentGone(framed, field);
            isEveryDocumentRead &&= elements !== null;
            isFound ||= elements !== null && elements.length > 0;
            toPaint.push({ framed, elements: elements ?? [] });
        }
        if (!isFound && !(isEveryDocumentRead && (await canBeLeftUnmasked(field)))) {
            return failure({
                code: "not-found",
                detail: "a field a secret was typed into cannot be found to hide it",
            });
        }
    }
    return success(
        await maskedScreenshot(scope, mask, async () => {
            for (const { framed, elements } of toPaint) {
                await framed.callForString(
                    maskGivenElements,
                    elements.map((element) => ({ element })),
                );
            }
        }),
    );
}

// Each field is found before anything is painted, so no image exists for a field that cannot be. A
// field its locator no longer finds holds nothing on screen only if the element typed into has gone
// and no other field holds what was typed: one still on the page may still show it, and a page may
// have rendered it afresh under another label. A document that has gone shows neither, and any other
// failure to read says nothing of the fields at all, so it is the capture's failure.
export async function screenshotHidingFields<Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
    fields: readonly ResolvedLocator[],
    holdsSecret: (text: string) => boolean,
): Promise<Result<Uint8Array, DriverError>> {
    try {
        const taken = await forAtMost(
            scope.timeout,
            screenshotWithFieldsHidden(scope, mask, fields, holdsSecret),
        );
        return taken === TIMED_OUT ? failure(notAnswering(scope.timeout)) : taken;
    } catch (error) {
        return failure(failureOfRead(scope, error));
    }
}
