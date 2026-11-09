// URLs a plan writes: one the browser opens, which must be relative or on an allowed origin, and
// one a check only compares.
import { PlanErrorCode, type AllowedUrl, type SafeText } from "@revisum/contracts";
import { brand } from "../../../foundation/Brand.ts";
import { INVALID, type Parsed } from "../../../decoding/ReadRecord.ts";
import { MAXIMUM_URL_LENGTH, WRITTEN_URL } from "../../../decoding/PlanFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readWrittenText } from "./ReadWrittenText.ts";

// A base used only to tell whether a URL is relative to the app under test.
const RELATIVE_BASE = new URL("https://relative.invalid");

const isWebProtocol = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

// The URL `text` names, read against RELATIVE_BASE, or undefined when it names none.
function urlOf(text: string): URL | undefined {
    try {
        return new URL(text, RELATIVE_BASE);
    } catch {
        return undefined;
    }
}

// A path on the app under test, as it will be stored. Stored as it stands, a path starting "//"
// would read as a path but take a browser to another host.
function readRelativeUrl(
    text: SafeText,
    url: URL,
    path: string,
    context: ParseContext,
): Parsed<AllowedUrl> {
    if (!text.startsWith("/") || url.pathname.startsWith("//")) {
        return refuse(context.issues, PlanErrorCode.InvalidUrl, path);
    }
    return brand<string, "AllowedUrl">(url.pathname + url.search + url.hash);
}

export function readUrl(input: unknown, path: string, context: ParseContext): Parsed<AllowedUrl> {
    const text = readWrittenText(input, path, context, MAXIMUM_URL_LENGTH);
    if (text === INVALID) {
        return INVALID;
    }
    const url = urlOf(text);
    if (url === undefined) {
        return refuse(context.issues, PlanErrorCode.InvalidUrl, path);
    }
    if (!isWebProtocol(url)) {
        return refuse(context.issues, PlanErrorCode.SchemeNotAllowed, path);
    }
    if (url.username !== "" || url.password !== "" || !WRITTEN_URL.test(text)) {
        return refuse(context.issues, PlanErrorCode.InvalidUrl, path);
    }
    if (url.origin === RELATIVE_BASE.origin) {
        return readRelativeUrl(text, url, path, context);
    }
    if (!context.rules.origins.some((origin) => origin === url.origin)) {
        return refuse(context.issues, PlanErrorCode.OriginNotAllowed, path);
    }
    return brand<string, "AllowedUrl">(url.href);
}

// True for a URL a check compares and never visits, such as a link's target or a canonical URL: an
// absolute http or https URL of any origin, or a path starting with "/", which the check resolves
// against the page's URL. Otherwise it records why not.
export function isComparedUrlElseRefused(
    text: SafeText,
    path: string,
    context: ParseContext,
): boolean {
    const url = urlOf(text);
    if (url === undefined) {
        refuse(context.issues, PlanErrorCode.InvalidUrl, path);
        return false;
    }
    if (!isWebProtocol(url)) {
        refuse(context.issues, PlanErrorCode.SchemeNotAllowed, path);
        return false;
    }
    const isRelative = url.origin === RELATIVE_BASE.origin;
    if (!WRITTEN_URL.test(text) || (isRelative && !text.startsWith("/"))) {
        refuse(context.issues, PlanErrorCode.InvalidUrl, path);
        return false;
    }
    return true;
}
