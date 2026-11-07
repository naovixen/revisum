import {
    PlanErrorCode,
    REQUEST_COUNT_KINDS,
    RequestCountKind,
    type RequestCount,
} from "@revisum/contracts";
import { INVALID, readInteger, readRecord, type Parsed } from "../../plan-decoders.ts";
import { MAXIMUM_EXPECTED_COUNT } from "../../plan-grammar.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readAssertionHead } from "./ReadAssertionHead.ts";

// How many matching requests a check expects: exactly one of equals, atLeast and atMost. Its one
// field is named by its kind, so it is read by hand rather than by a field table.
export function readRequestCount(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<RequestCount> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kind = REQUEST_COUNT_KINDS.find((candidate) => Object.hasOwn(head, candidate));
    const allowed = kind === undefined ? [] : [kind];
    if (readRecord(input, path, context.issues, allowed) === INVALID || kind === undefined) {
        return INVALID;
    }
    const countPath = `${path}.${kind}`;
    const count = readInteger(head[kind], countPath, context.issues, 0, MAXIMUM_EXPECTED_COUNT);
    if (count === INVALID) {
        return INVALID;
    }
    switch (kind) {
        case RequestCountKind.Equals:
            return { equals: count };
        case RequestCountKind.AtLeast:
            // Any page sends at least 0 requests, so that check would prove nothing.
            return count === 0
                ? refuse(context.issues, PlanErrorCode.Vacuous, countPath)
                : { atLeast: count };
        case RequestCountKind.AtMost:
            return { atMost: count };
    }
}
