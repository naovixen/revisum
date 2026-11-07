// What every assertion starts with: an object that checks something, and a kind that says which
// fields it has.
import { PlanErrorCode } from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, peekRecord, type Parsed } from "../../plan-decoders.ts";
import { readFields, type FieldReader } from "../../ReadFields.ts";
import { knownField } from "../KnownField.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";

// The assertion's fields, unchecked, to read its kind by. An assertion written as `{}` checks
// nothing, so it is vacuous rather than merely incomplete.
export function readAssertionHead(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Readonly<Record<string, unknown>>> {
    const head = peekRecord(input, path, context.issues);
    if (head === INVALID) {
        return INVALID;
    }
    if (Object.keys(head).length === 0) {
        return refuse(context.issues, PlanErrorCode.Vacuous, path);
    }
    return head;
}

// An assertion of a kind already read whose only field is that kind.
export function readKindAlone<const Kind extends string>(
    input: unknown,
    path: string,
    context: ParseContext,
    kind: Kind,
): Parsed<{ readonly kind: Kind }> {
    const fields = readFields(input, path, context.issues, { kind: knownField(kind) });
    return fields === INVALID ? INVALID : { kind };
}

// An assertion of a kind already read with one more field, `value`, read by `readValue`.
export function readKindAndValue<const Kind extends string, Value>(
    input: ReadableInput,
    path: string,
    context: ParseContext,
    kind: Kind,
    readValue: FieldReader<Value, ReadableInput>,
): Parsed<{ readonly kind: Kind; readonly value: Value }> {
    const fields = readFields(input, path, context.issues, {
        kind: knownField(kind),
        value: readValue,
    });
    return fields === INVALID ? INVALID : { kind, value: fields.value };
}
