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
    maskElements,
    maskGivenElements,
    unmaskElements,
} from "../in-page/MaskElements.ts";
import type { PageOperations } from "../page/PageOperations.ts";
import { failureOfRead, readOfPage, type DocumentScope } from "./DocumentScope.ts";
import { findElementsUnlessDocumentGone } from "./FindElements.ts";
import { answeredWithin, forAtMost, notAnswering, TIMED_OUT } from "./ForAtMost.ts";
import { hasFieldHoldingASecret, hasTypedFieldGone } from "./HasTypedFieldGone.ts";

// What masks paint before the viewport is captured, then take away.
async function maskedScreenshot<Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
    paintBesides: () => Promise<void>,
): Promise<Uint8Array> {
    await scope.operations.callForString(fontsReady, []);
    for (const framed of scope.masked) {
        await framed.callForString(maskElements, [mask]);
    }
    try {
        await paintBesides();
        return await scope.operations.screenshotPng();
    } finally {
        for (const framed of scope.masked) {
            await framed.callForString(unmaskElements, []);
        }
    }
}

export const screenshotDocument = <Handle>(
    scope: DocumentScope<Handle>,
    mask: readonly string[],
): Promise<Result<Uint8Array, PageReadFailure>> =>
    readOfPage(scope, () =>
        answeredWithin(
            scope.timeout,
            maskedScreenshot(scope, mask, () => Promise.resolve()),
        ),
    );

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
