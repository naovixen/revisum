import {
    PageAssertionKind,
    PlanErrorCode,
    type PageAssertion,
    type SafeText,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, readOneOf, type Parsed } from "../ReadRecord.ts";
import {
    MAXIMUM_META_NAME_LENGTH,
    MAXIMUM_URL_LENGTH,
    PAGE_KINDS,
} from "../../schema/PlanFields.ts";
import { readFields } from "../../ReadFields.ts";
import { knownField } from "../KnownField.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readExpectedText } from "../text/ReadTextOrValue.ts";
import { isComparedUrlElseRefused, readUrl } from "../text/ReadUrl.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";
import { readAssertionHead, readKindAndValue } from "./ReadAssertionHead.ts";

function readCanonicalUrl(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
    const canonical = readWrittenText(input, path, context, MAXIMUM_URL_LENGTH);
    return canonical === INVALID || !isComparedUrlElseRefused(canonical, path, context)
        ? INVALID
        : canonical;
}

// A plain text prefix of the path, so it must start where every path starts.
function readPathPrefix(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
    const prefix = readWrittenText(input, path, context, MAXIMUM_URL_LENGTH);
    if (prefix !== INVALID && !prefix.startsWith("/")) {
        return refuse(context.issues, PlanErrorCode.InvalidUrl, path);
    }
    return prefix;
}

function readMetaContent(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<PageAssertion> {
    const fields = readFields(input, path, context.issues, {
        kind: knownField(PageAssertionKind.MetaContent),
        name: (name: unknown, namePath: string) =>
            readWrittenText(name, namePath, context, MAXIMUM_META_NAME_LENGTH),
        value: (value: unknown, valuePath: string) => readExpectedText(value, valuePath, context),
    });
    return fields === INVALID
        ? INVALID
        : { kind: fields.kind, name: fields.name, value: fields.value };
}

export function readPageAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<PageAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kind = readOneOf(head["kind"], `${path}.kind`, context.issues, PAGE_KINDS);
    switch (kind) {
        case INVALID:
            return INVALID;
        case PageAssertionKind.MetaContent:
            return readMetaContent(input, path, context);
        case PageAssertionKind.CanonicalUrl:
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readCanonicalUrl(value, valuePath, context),
            );
        case PageAssertionKind.Url:
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readUrl(value, valuePath, context),
            );
        case PageAssertionKind.UrlPathStartsWith:
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readPathPrefix(value, valuePath, context),
            );
        default: {
            // A page may have an empty title, so an empty expected title or path is a real check.
            const longest = context.rules.limits.maximumTextLength;
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readWrittenText(value, valuePath, context, longest, 0),
            );
        }
    }
}
