// Where a remember step reads: the clipboard's plain text, a field of the latest response a
// declared request check saw, or one element of the page.
import {
    CLIPBOARD_READS,
    isNonArrayObject,
    REMEMBER_ATTRIBUTE_READ,
    REMEMBER_READS,
    RESPONSE_READS,
    type RememberSource,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, readOneOf, readRecord, type Parsed } from "../ReadRecord.ts";
import { ATTRIBUTE_NAME, DOM_CHECKS_FEATURE } from "../../schema/PlanFields.ts";
import { readFields } from "../../ReadFields.ts";
import { readDeclaredField, readRequestName } from "./ReadDeclared.ts";
import { knownField } from "../KnownField.ts";
import { readLocator } from "../locators/ReadLocator.ts";
import { isFeatureEnabledElseRefused, type ParseContext } from "../ParseContext.ts";
import { readLiteralName } from "../text/ReadLiteralName.ts";

// The clipboard's plain text, the only clipboard format a plan may read.
function readClipboardSource(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<RememberSource> {
    const fields = readFields(input, path, context.issues, {
        clipboard: (clipboard: unknown, clipboardPath: string) =>
            readOneOf(clipboard, clipboardPath, context.issues, CLIPBOARD_READS),
    });
    return fields === INVALID ? INVALID : { clipboard: fields.clipboard };
}

// A field of a response. An undeclared request is refused alone: its fields are not read against
// nothing. Its `read` is read before its `field`, which depends on the request, so a field table,
// which reads in one fixed order, can't read it.
function readResponseSource(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<RememberSource> {
    const fields = readRecord(input, path, context.issues, ["response", "field", "read"]);
    if (fields === INVALID) {
        return INVALID;
    }
    const named = readRequestName(fields["response"], `${path}.response`, context);
    const read = readOneOf(fields["read"], `${path}.read`, context.issues, RESPONSE_READS);
    if (named === INVALID) {
        return INVALID;
    }
    const fieldPath = `${path}.field`;
    const field = readDeclaredField(fields["field"], fieldPath, named.declaration.fields, context);
    return field === INVALID || read === INVALID ? INVALID : { response: named.name, field, read };
}

const readElement = (context: ParseContext) => (input: unknown, path: string) =>
    readLocator(input, path, context);

// One of an element's attributes: a DOM check, so read only once the project enables them.
function readAttributeSource(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<RememberSource> {
    if (!isFeatureEnabledElseRefused(DOM_CHECKS_FEATURE, `${path}.read`, context)) {
        return INVALID;
    }
    const fields = readFields(input, path, context.issues, {
        element: readElement(context),
        read: knownField(REMEMBER_ATTRIBUTE_READ),
        attribute: (attribute: unknown, attributePath: string) =>
            readLiteralName(attribute, attributePath, context, ATTRIBUTE_NAME),
    });
    return fields === INVALID
        ? INVALID
        : { element: fields.element, read: fields.read, attribute: fields.attribute };
}

function readElementSource(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<RememberSource> {
    const fields = readFields(input, path, context.issues, {
        element: readElement(context),
        read: (read: unknown, readPath: string) =>
            readOneOf(read, readPath, context.issues, REMEMBER_READS),
    });
    return fields === INVALID ? INVALID : { element: fields.element, read: fields.read };
}

export function readRememberSource(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<RememberSource> {
    if (isNonArrayObject(input) && Object.hasOwn(input, "clipboard")) {
        return readClipboardSource(input, path, context);
    }
    if (isNonArrayObject(input) && Object.hasOwn(input, "response")) {
        return readResponseSource(input, path, context);
    }
    if (isNonArrayObject(input) && input["read"] === REMEMBER_ATTRIBUTE_READ) {
        return readAttributeSource(input, path, context);
    }
    return readElementSource(input, path, context);
}
