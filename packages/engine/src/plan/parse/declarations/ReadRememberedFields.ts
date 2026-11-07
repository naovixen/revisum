import {
    isPlainObject,
    PlanErrorCode,
    type FieldName,
    type JsonPointer,
    type ValueName,
} from "@revisum/contracts";
import { brand } from "../../../brand.ts";
import { allValid, INVALID, type Parsed } from "../../plan-decoders.ts";
import { readValueName } from "../../plan-values.ts";
import { isNameTaken, type ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";

function readRememberedField(
    key: string,
    field: unknown,
    path: string,
    declared: readonly string[],
    context: ParseContext,
): Parsed<readonly [ValueName, FieldName]> {
    const name = readValueName(key, path, context.issues);
    if (name === INVALID) {
        return INVALID;
    }
    if (isNameTaken(name, context)) {
        return refuse(context.issues, PlanErrorCode.Duplicate, path);
    }
    if (typeof field !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    if (!declared.includes(field)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    return [name, brand<string, "FieldName">(field)];
}

// The fields of a call's response, a script's result or a command's output that a step remembers,
// as run values for the steps after it, each defined once all are read. Each field is one the
// declaration gives; each name is new, as a remember step's would be. The keys are names the plan
// chooses, so no field table can list them.
export function readRememberedFields(
    input: unknown,
    path: string,
    declaredFields: Readonly<Record<FieldName, JsonPointer>> | undefined,
    context: ParseContext,
): Parsed<Readonly<Record<ValueName, FieldName>>> {
    if (!isPlainObject(input)) {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    const declared = Object.keys(declaredFields ?? {});
    const entries = Object.entries(input).map(([key, field]) =>
        readRememberedField(key, field, `${path}.${key}`, declared, context),
    );
    if (!allValid(entries)) {
        return INVALID;
    }
    for (const [name] of entries) {
        context.defined.add(name);
    }
    return Object.fromEntries(entries);
}
