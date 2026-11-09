// Text a plan writes for the page: literal text, or a reference to a run value defined earlier.
import {
    isNonArrayObject,
    PlanErrorCode,
    type TextOrValue,
    type ValueReference,
} from "@revisum/contracts";
import { normalise } from "../../../run/outcome/Verdict.ts";
import { INVALID, type Parsed } from "../ReadRecord.ts";
import { readValueName } from "../declarations/ReadPlanClock.ts";
import { readFields } from "../../ReadFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readWrittenText } from "./ReadWrittenText.ts";

// A reference { "valueName": … } to a run value defined earlier in the plan. An undefined name is
// reported at the reference itself.
export function readValueReference(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<ValueReference> {
    const fields = readFields(input, path, context.issues, { valueName: readValueName });
    if (fields === INVALID) {
        return INVALID;
    }
    if (!context.defined.has(fields.valueName)) {
        return refuse(context.issues, PlanErrorCode.UndefinedValue, path);
    }
    return { valueName: fields.valueName };
}

export function readTextOrValue(
    input: unknown,
    path: string,
    context: ParseContext,
    maximumLength: number,
    minimumLength = 1,
): Parsed<TextOrValue> {
    if (isNonArrayObject(input)) {
        return readValueReference(input, path, context);
    }
    return readWrittenText(input, path, context, maximumLength, minimumLength);
}

// True for text a plan writes that holds nothing once its white space is collapsed.
export const isBlankText = (value: TextOrValue): boolean =>
    typeof value === "string" && normalise(value) === "";

const refusingBlank = (
    value: Parsed<TextOrValue>,
    path: string,
    context: ParseContext,
): Parsed<TextOrValue> =>
    value !== INVALID && isBlankText(value)
        ? refuse(context.issues, PlanErrorCode.Vacuous, path)
        : value;

// Expected text for a text check. Blank text is found inside any text, so the check proves nothing.
export const readExpectedText = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<TextOrValue> =>
    refusingBlank(
        readTextOrValue(input, path, context, context.rules.limits.maximumTextLength, 0),
        path,
        context,
    );

// Text a locator looks for on the page. Blank text names nothing, so an absent check of it proves
// nothing.
export const readWantedText = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<TextOrValue> =>
    refusingBlank(
        readTextOrValue(input, path, context, context.rules.limits.maximumTextLength),
        path,
        context,
    );
