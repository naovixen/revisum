// A check on the clipboard's plain text. Only textEquals compares against several lines; for
// textContains and textExcludes, lines are the wrong type of value.
import {
    CLIPBOARD_ASSERTION_KINDS,
    ClipboardAssertionKind,
    isNonArrayObject,
    PlanErrorCode,
    type ClipboardAssertion,
    type MultiLineText,
    type TextOrValue,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, readOneOf, type Parsed } from "../ReadRecord.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readMultiLineText } from "../text/ReadMultiLineText.ts";
import { isBlankText, readExpectedText } from "../text/ReadTextOrValue.ts";
import { readAssertionHead, readKindAndValue } from "./ReadAssertionHead.ts";

// Expected clipboard text written as lines, within the fill limits. Lines that are all blank are
// blank text, which would make the check vacuous.
function readExpectedLines(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<MultiLineText> {
    const lines = readMultiLineText(input, path, context);
    if (lines !== INVALID && lines.lines.every(isBlankText)) {
        return refuse(context.issues, PlanErrorCode.Vacuous, path);
    }
    return lines;
}

const isWrittenAsLines = (value: ReadableInput): boolean =>
    isNonArrayObject(value) && Object.hasOwn(value, "lines");

const readTextOrLines = (
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<TextOrValue | MultiLineText> =>
    isWrittenAsLines(input)
        ? readExpectedLines(input, path, context)
        : readExpectedText(input, path, context);

const readTextNotLines = (
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<TextOrValue> =>
    isWrittenAsLines(input)
        ? refuse(context.issues, PlanErrorCode.WrongType, path)
        : readExpectedText(input, path, context);

export function readClipboardAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<ClipboardAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kindPath = `${path}.kind`;
    const kind = readOneOf(head["kind"], kindPath, context.issues, CLIPBOARD_ASSERTION_KINDS);
    if (kind === INVALID) {
        return INVALID;
    }
    if (kind === ClipboardAssertionKind.TextEquals) {
        return readKindAndValue(input, path, context, kind, (value, valuePath) =>
            readTextOrLines(value, valuePath, context),
        );
    }
    return readKindAndValue(input, path, context, kind, (value, valuePath) =>
        readTextNotLines(value, valuePath, context),
    );
}
