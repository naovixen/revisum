// A check on a field of a call's response, a script's result or a command's output.
import {
    BACKEND_ASSERTION_KINDS,
    BackendAssertionKind,
    PlanErrorCode,
    type BackendAssertion,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, readOneOf, type Issues, type Parsed } from "../../../decoding/ReadRecord.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readExpectedText } from "../text/ReadTextOrValue.ts";
import { readAssertionHead, readKindAlone, readKindAndValue } from "./ReadAssertionHead.ts";

const readFiniteNumber = (input: unknown, path: string, issues: Issues): Parsed<number> =>
    typeof input === "number" && Number.isFinite(input)
        ? input
        : refuse(issues, PlanErrorCode.WrongType, path);

export function readBackendAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<BackendAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kind = readOneOf(head["kind"], `${path}.kind`, context.issues, BACKEND_ASSERTION_KINDS);
    switch (kind) {
        case INVALID:
            return INVALID;
        case BackendAssertionKind.Present:
        case BackendAssertionKind.Absent:
            return readKindAlone(input, path, context, kind);
        case BackendAssertionKind.NumberEquals:
            return readKindAndValue(input, path, context, kind, readFiniteNumber);
        case BackendAssertionKind.Equals:
        case BackendAssertionKind.Contains:
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readExpectedText(value, valuePath, context),
            );
    }
}
