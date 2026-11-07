import {
    STORAGE_ASSERTION_KINDS,
    StorageAssertionKind,
    type StorageAssertion,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, readOneOf, type Parsed } from "../../plan-decoders.ts";
import type { ParseContext } from "../ParseContext.ts";
import { readExpectedText } from "../text/ReadTextOrValue.ts";
import { readAssertionHead, readKindAlone, readKindAndValue } from "./ReadAssertionHead.ts";

export function readStorageAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<StorageAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kindPath = `${path}.kind`;
    const kind = readOneOf(head["kind"], kindPath, context.issues, STORAGE_ASSERTION_KINDS);
    if (kind === INVALID) {
        return INVALID;
    }
    if (kind !== StorageAssertionKind.Equals) {
        return readKindAlone(input, path, context, kind);
    }
    return readKindAndValue(input, path, context, kind, (value, valuePath) =>
        readExpectedText(value, valuePath, context),
    );
}
