// What a fill step types: literal text, a reference to a secret the project declares, a value
// reference or lines of text.
import {
    isNonArrayObject,
    literalText,
    type MultiLineText,
    type SecretReference,
    type TextOrValue,
} from "@revisum/contracts";
import type { Parsed } from "../ReadRecord.ts";
import { readSecretReference } from "../declarations/ReadDeclared.ts";
import type { ParseContext } from "../ParseContext.ts";
import { readMultiLineText } from "./ReadMultiLineText.ts";
import { readValueReference } from "./ReadTextOrValue.ts";
import { readWrittenText } from "./ReadWrittenText.ts";

export type FillValue = TextOrValue | SecretReference | MultiLineText;

export function readFillValue(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<FillValue> {
    if (!isNonArrayObject(input)) {
        return readWrittenText(input, path, context, context.rules.limits.maximumTextLength, 0);
    }
    if (Object.hasOwn(input, "lines")) {
        return readMultiLineText(input, path, context);
    }
    if (Object.hasOwn(input, "valueName")) {
        return readValueReference(input, path, context);
    }
    return readSecretReference(input, path, context);
}

const isWritten = (text: TextOrValue): boolean => (literalText(text) ?? "") !== "";

// True when a fill value writes literal text, as a password typed into the plan would be.
export function holdsLiteralText(value: FillValue): boolean {
    if (typeof value === "object" && "lines" in value) {
        return value.lines.some(isWritten);
    }
    if (typeof value === "object" && "secretName" in value) {
        return false;
    }
    return isWritten(value);
}
