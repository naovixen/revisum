// A read-only look at the element a locator matches in one document.
import {
    isSeveralElements,
    UnreadablePage,
    type DomRead,
    type DomValue,
    type ElementProbe,
    type OneElementRead,
    type ResolvedLocator,
} from "@revisum/contracts";
import { MalformedBrowserReply } from "../connection/MalformedBrowserReply.ts";
import { documentUrl } from "../in-page/PageInfo.ts";
import { linkAndCurrent, probeElement, readDomValue } from "../in-page/ProbeElement.ts";
import { PageHeldByDialog } from "../page/PageHeldByDialog.ts";
import type { DocumentScope } from "./DocumentScope.ts";
import { findElements, rejectsSelector } from "./FindElements.ts";
import { forAtMost, TIMED_OUT } from "./ForAtMost.ts";
import { boxOf, fieldsOf, reportedBoolean, reportedFields } from "./ReportedFields.ts";
import { isElementEnabled } from "./WaitUntilActionable.ts";

const REJECTED_SELECTOR: ElementProbe = { count: "selector-invalid" };
const NOTHING_MATCHES: ElementProbe = { count: 0 };
const READ_FAILED: ElementProbe = { count: UnreadablePage.ReadFailed };
const DIALOG_HOLDS_PAGE: ElementProbe = { count: UnreadablePage.DialogOpen };
const ON_BROWSER_ERROR_PAGE: ElementProbe = { count: UnreadablePage.BrowserErrorPage };

// The scheme of the page the browser shows in place of one it could not show.
export const BROWSER_ERROR_PAGE = "chrome-error:";

// Decodes what probeElement (in-page/ProbeElement.ts) reports, of the one element it was called on.
function decodeShownElement(text: string): Omit<OneElementRead, "states" | "href" | "enabled"> {
    const source = "probeElement";
    const fields = reportedFields(text, source);
    const shownText = fields["text"];
    const value = fields["value"];
    if (typeof shownText !== "string") {
        throw new MalformedBrowserReply(source, "report.text");
    }
    if (typeof value !== "string" && value !== null) {
        throw new MalformedBrowserReply(source, "report.value");
    }
    const box = boxOf(fields["box"]);
    if (box === null) {
        throw new MalformedBrowserReply(source, "report.box");
    }
    return {
        count: 1,
        visible: reportedBoolean(fields, "visible", source),
        text: shownText,
        value,
        sensitive: reportedBoolean(fields, "sensitive", source),
        box,
    };
}

function decodeCurrent(current: unknown): boolean | null {
    if (current === "true") {
        return true;
    }
    return current === "false" ? false : null;
}

// Decodes what linkAndCurrent reports. A field of another shape is read as not shown.
function decodeLinkAndCurrent(text: string): {
    readonly href: string | null;
    readonly current: boolean | null;
} {
    const fields = fieldsOf(JSON.parse(text));
    const href = fields["href"];
    return {
        href: typeof href === "string" ? href : null,
        current: decodeCurrent(fields["current"]),
    };
}

// Decodes what readDomValue reports, keeping it only when it is the read asked for.
function decodeDomValue(text: string, read: DomRead): DomValue | undefined {
    const { classes, value } = fieldsOf(JSON.parse(text));
    switch (read.kind) {
        case "classes":
            return Array.isArray(classes) && classes.every((token) => typeof token === "string")
                ? { kind: "classes", classes: classes.filter((token) => typeof token === "string") }
                : undefined;
        case "computedStyle":
            return typeof value === "string" ? { kind: "computedStyle", value } : undefined;
        case "attribute":
            return typeof value === "string" || value === null
                ? { kind: "attribute", value }
                : undefined;
    }
}

// The style property or attribute a DOM read names; empty for the class list.
const domReadName = (read: DomRead): string => {
    switch (read.kind) {
        case "computedStyle":
            return read.property;
        case "attribute":
            return read.name;
        case "classes":
            return "";
    }
};

async function probeNow<Handle>(
    scope: DocumentScope<Handle>,
    locator: ResolvedLocator,
    read: DomRead | null,
): Promise<ElementProbe> {
    const { operations, environment } = scope;
    if (scope.events.crashed()) {
        return READ_FAILED;
    }
    try {
        if (await rejectsSelector(operations, locator)) {
            return REJECTED_SELECTOR;
        }
        const found = await findElements(operations, locator);
        // Looked at after the search, so a navigation that fails during it cannot read as a page
        // with nothing on it.
        if ((await operations.callForString(documentUrl, [])).startsWith(BROWSER_ERROR_PAGE)) {
            return ON_BROWSER_ERROR_PAGE;
        }
        const count = found.length;
        if (isSeveralElements(count)) {
            return { count };
        }
        const element = found[0];
        if (element === undefined) {
            return NOTHING_MATCHES;
        }
        const shown = decodeShownElement(
            await operations.callForString(probeElement, [
                { element },
                environment.sensitiveSelectors,
            ]),
        );
        // The link target and aria-current come from the document, the other states from the
        // browser's accessibility engine, as assistive technology reads them.
        const { href, current: isCurrent } = decodeLinkAndCurrent(
            await operations.callForString(linkAndCurrent, [{ element }]),
        );
        const exposed = await operations.exposedStates(element);
        // A DOM check's read: a class list, a computed style or an attribute, read from the document.
        const dom =
            read === null
                ? undefined
                : decodeDomValue(
                      await operations.callForString(readDomValue, [
                          { element },
                          read.kind,
                          domReadName(read),
                      ]),
                      read,
                  );
        const isEnabled = await isElementEnabled(operations, element);
        return {
            ...shown,
            enabled: isEnabled,
            states: { ...exposed, current: isCurrent },
            href,
            ...(dom === undefined ? {} : { dom }),
        };
    } catch (error) {
        return error instanceof PageHeldByDialog ? DIALOG_HOLDS_PAGE : READ_FAILED;
    }
}

// A read the page does not answer in time is one that says nothing about what is on it.
export async function probeDocument<Handle>(
    scope: DocumentScope<Handle>,
    locator: ResolvedLocator,
    read: DomRead | null,
): Promise<ElementProbe> {
    const probed = await forAtMost(scope.timeout, probeNow(scope, locator, read));
    return probed === TIMED_OUT ? READ_FAILED : probed;
}
