// A check on the latest exchange matching an observed request: its status, or a field the request
// declares.
import {
    RESPONSE_ASSERTION_KINDS,
    RESPONSE_FIELD_PRESENCE_KINDS,
    ResponseAssertionKind,
    type FieldName,
    type ObservedRequestDeclaration,
    type ResponseAssertion,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import {
    INVALID,
    isOneOf,
    readInteger,
    readOneOf,
    type Parsed,
} from "../../../decoding/ReadRecord.ts";
import { RESPONSE_STATUS } from "../../../decoding/PlanFields.ts";
import { readFields } from "../../ReadFields.ts";
import { readDeclaredField } from "../declarations/ReadDeclared.ts";
import { knownField } from "../KnownField.ts";
import type { ParseContext } from "../ParseContext.ts";
import { readExpectedText } from "../text/ReadTextOrValue.ts";
import { readAssertionHead, readKindAndValue } from "./ReadAssertionHead.ts";

export function readResponseAssertion(
    input: ReadableInput,
    path: string,
    declaration: ObservedRequestDeclaration,
    context: ParseContext,
): Parsed<ResponseAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kindPath = `${path}.kind`;
    const kind = readOneOf(head["kind"], kindPath, context.issues, RESPONSE_ASSERTION_KINDS);
    if (kind === INVALID) {
        return INVALID;
    }
    if (kind === ResponseAssertionKind.StatusEquals) {
        const { lowest, highest } = RESPONSE_STATUS;
        return readKindAndValue(input, path, context, kind, (value, valuePath, issues) =>
            readInteger(value, valuePath, issues, lowest, highest),
        );
    }
    const field = (written: unknown, fieldPath: string): Parsed<FieldName> =>
        readDeclaredField(written, fieldPath, declaration.fields, context);
    if (isOneOf(RESPONSE_FIELD_PRESENCE_KINDS, kind)) {
        const fields = readFields(input, path, context.issues, { kind: knownField(kind), field });
        return fields === INVALID ? INVALID : { kind, field: fields.field };
    }
    const fields = readFields(input, path, context.issues, {
        kind: knownField(kind),
        field,
        value: (value: unknown, valuePath: string) => readExpectedText(value, valuePath, context),
    });
    return fields === INVALID ? INVALID : { kind, field: fields.field, value: fields.value };
}
