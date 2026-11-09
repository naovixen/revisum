import { PlanErrorCode, type SafeText } from "@revisum/contracts";
import { INVALID, type Parsed } from "../ReadRecord.ts";
import { MAXIMUM_LITERAL_NAME_LENGTH } from "../../schema/PlanFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readWrittenText } from "./ReadWrittenText.ts";

// A literal name that must match `pattern`, such as a class token or an attribute name: never a
// value reference, since it says what the check reads. The error never repeats the name.
export function readLiteralName(
    input: unknown,
    path: string,
    context: ParseContext,
    pattern: RegExp,
): Parsed<SafeText> {
    const name = readWrittenText(input, path, context, MAXIMUM_LITERAL_NAME_LENGTH);
    if (name !== INVALID && !pattern.test(name)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    return name;
}
