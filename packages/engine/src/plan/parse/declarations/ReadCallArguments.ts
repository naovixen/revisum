// The arguments a step gives a declaration's parameters: exactly the declaration's parameters,
// each typed by it. Calls, stubs, storage entries, page scripts and commands all take them so.
import {
    isNonArrayObject,
    ParameterKind,
    PlanErrorCode,
    type CallArgument,
    type CallArguments,
    type ParameterName,
    type ParameterType,
    type SafeText,
    type ScriptArgument,
    type ScriptArguments,
    type ScriptParameterType,
} from "@revisum/contracts";
import { argumentProblem } from "../../../run/executors/service-calls/ArgumentValue.ts";
import { readableCopy, type ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, type Parsed } from "../../../decoding/ReadRecord.ts";
import { readFields, type FieldReader } from "../../ReadFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readValueReference } from "../text/ReadTextOrValue.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";
import { readSecretReference } from "./ReadDeclared.ts";

type ArgumentReader<Type, Argument> = (
    input: ReadableInput,
    path: string,
    type: Type,
    context: ParseContext,
) => Parsed<Argument>;

// A literal argument's value before its parameter's type judges it. A text parameter's own limit
// comes first, as too_long; the other types judge length by their own rules.
function readLiteral(
    input: unknown,
    path: string,
    type: ScriptParameterType,
    context: ParseContext,
): Parsed<SafeText | number | boolean> {
    if (typeof input === "string") {
        const longest =
            type.kind === ParameterKind.Text ? type.maximumLength : Number.POSITIVE_INFINITY;
        return readWrittenText(input, path, context, longest, 0);
    }
    if (typeof input === "number" || typeof input === "boolean") {
        return input;
    }
    return refuse(context.issues, PlanErrorCode.WrongType, path);
}

// An argument for a parameter that is not a secret: a literal value or a run value by name. A
// literal's type is checked here; a run value's when its text is known, by the request builder,
// under the same rules. A secret reference here is the wrong type: a page script or a command never
// takes one.
function readPlainArgument(
    input: ReadableInput,
    path: string,
    type: ScriptParameterType,
    context: ParseContext,
): Parsed<ScriptArgument> {
    if (isNonArrayObject(input)) {
        return Object.hasOwn(input, "valueName")
            ? readValueReference(input, path, context)
            : refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    const value = readLiteral(input, path, type, context);
    if (value === INVALID) {
        return INVALID;
    }
    const problem = argumentProblem(type, value);
    return problem === undefined ? value : refuse(context.issues, problem, path);
}

// One call argument, as its parameter's type allows: a secret only by name, since literal text in
// a secret parameter would put the secret in the plan; anything else as a plain argument.
function readCallArgument(
    input: ReadableInput,
    path: string,
    type: ParameterType,
    context: ParseContext,
): Parsed<CallArgument> {
    if (type.kind !== ParameterKind.Secret) {
        return readPlainArgument(input, path, type, context);
    }
    if (isNonArrayObject(input) && Object.hasOwn(input, "secretName")) {
        return readSecretReference(input, path, context);
    }
    const code = typeof input === "string" ? PlanErrorCode.LiteralSecret : PlanErrorCode.WrongType;
    return refuse(context.issues, code, path);
}

// Exactly the declaration's parameters, each read by `readOne`: a missing one and an extra one are
// both refused.
function readArgumentsWith<Type, Argument>(
    input: ReadableInput,
    path: string,
    declared: Readonly<Record<ParameterName, Type>>,
    context: ParseContext,
    readOne: ArgumentReader<Type, Argument>,
): Parsed<Readonly<Record<ParameterName, Argument>>> {
    if (!isNonArrayObject(input)) {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    const parameters: Readonly<Record<string, FieldReader<Argument, ReadableInput>>> =
        Object.fromEntries(
            Object.entries<Type>(declared).map(([name, type]) => [
                name,
                (written: ReadableInput, argumentPath: string) =>
                    readOne(written, argumentPath, type, context),
            ]),
        );
    return readFields(input, path, context.issues, parameters);
}

export const readCallArguments = (
    input: ReadableInput,
    path: string,
    declared: Readonly<Record<ParameterName, ParameterType>>,
    context: ParseContext,
): Parsed<CallArguments> => readArgumentsWith(input, path, declared, context, readCallArgument);

export const readScriptArguments = (
    input: ReadableInput,
    path: string,
    declared: Readonly<Record<ParameterName, ScriptParameterType>>,
    context: ParseContext,
): Parsed<ScriptArguments> => readArgumentsWith(input, path, declared, context, readPlainArgument);

// The arguments read when a step gives none.
const NO_ARGUMENTS = readableCopy({});

// Arguments for a stub start or a storage write. Undefined, so left out of the step, when the plan
// leaves them out, and then read as none, so a declaration with parameters still has each one
// reported missing.
export function readOptionalArguments(
    step: { readonly arguments?: ReadableInput },
    path: string,
    declared: Readonly<Record<ParameterName, ParameterType>>,
    context: ParseContext,
): Parsed<CallArguments | undefined> {
    const isGiven = Object.hasOwn(step, "arguments");
    const written = isGiven ? step.arguments : NO_ARGUMENTS;
    const stepArguments = readCallArguments(written, `${path}.arguments`, declared, context);
    if (stepArguments === INVALID) {
        return INVALID;
    }
    return isGiven ? stepArguments : undefined;
}
