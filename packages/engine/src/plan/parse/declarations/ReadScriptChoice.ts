// The script a page-script step runs: a name the project declares, or a script written inline.
import {
    CALL_EFFECTS,
    isNonArrayObject,
    PlanErrorCode,
    type CallEffect,
    type FieldName,
    type InlineScript,
    type JsonPointer,
    type ParameterName,
    type ScriptChoice,
    type ScriptParameterType,
    type ScriptSource,
} from "@revisum/contracts";
import { brand } from "../../../brand.ts";
import { readFieldPointers } from "../../../project/call-declarations.ts";
import { looksLikeCredential } from "../../literal-secrets.ts";
import {
    allValid,
    INVALID,
    isUnsafeSource,
    readOneOf,
    type Issues,
    type Parsed,
} from "../../plan-decoders.ts";
import { MAXIMUM_INLINE_SCRIPT_LENGTH } from "../../plan-grammar.ts";
import { optionalField, readFields } from "../../ReadFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";
import { readScriptName } from "./ReadDeclared.ts";

// What a step's script is, whether named or inline: its parameters, effect and result fields, and
// where a check that needs a read script reports a write one.
export type ScriptUse = {
    readonly script: ScriptChoice;
    readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
    readonly effect: CallEffect;
    readonly fields: Readonly<Record<FieldName, JsonPointer>> | undefined;
    readonly effectPath: string;
};

// A script's source text: 1 to MAXIMUM_INLINE_SCRIPT_LENGTH characters, line breaks allowed, no
// other control characters, and nothing shaped like a credential.
function readScriptSource(input: unknown, path: string, issues: Issues): Parsed<ScriptSource> {
    if (typeof input !== "string") {
        return refuse(issues, PlanErrorCode.WrongType, path);
    }
    if (input.length === 0) {
        return refuse(issues, PlanErrorCode.Empty, path);
    }
    if (input.length > MAXIMUM_INLINE_SCRIPT_LENGTH) {
        return refuse(issues, PlanErrorCode.TooLong, path);
    }
    if (isUnsafeSource(input)) {
        return refuse(issues, PlanErrorCode.UnsafeText, path);
    }
    if (looksLikeCredential(input)) {
        return refuse(issues, PlanErrorCode.LiteralSecret, path);
    }
    return brand<string, "ScriptSource">(input);
}

// An inline script's result fields. The pointers are written by the plan, not by a person in the
// trusted project, and the approver reads them, so they are held to the rules of plan text too. An
// empty pointer names the whole result.
function readInlineFields(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Readonly<Record<FieldName, JsonPointer>>> {
    const fields = readFieldPointers(input, path, context.issues);
    if (fields === INVALID) {
        return INVALID;
    }
    const longest = context.rules.limits.maximumTextLength;
    const pointers = Object.entries(fields).map(([name, pointer]) =>
        readWrittenText(pointer, `${path}.${name}`, context, longest, 0),
    );
    return allValid(pointers) ? fields : INVALID;
}

// An inline script: its source, its effect as the plan claims it, and its result fields. It takes
// no parameters, so its arguments are always {}. Its result fields are read first.
function readInlineScript(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<InlineScript> {
    const script = readFields(input, path, context.issues, {
        fields: optionalField((fields: unknown, fieldsPath: string) =>
            readInlineFields(fields, fieldsPath, context),
        ),
        source: readScriptSource,
        effect: (effect: unknown, effectPath: string, issues: Issues) =>
            readOneOf(effect, effectPath, issues, CALL_EFFECTS),
    });
    if (script === INVALID) {
        return INVALID;
    }
    const { source, effect, fields } = script;
    return { source, effect, ...(fields === undefined ? {} : { fields }) };
}

export function readScriptChoice(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<ScriptUse> {
    if (isNonArrayObject(input)) {
        const choice = readFields(input, path, context.issues, {
            inline: (inline: unknown, inlinePath: string) =>
                readInlineScript(inline, inlinePath, context),
        });
        if (choice === INVALID) {
            return INVALID;
        }
        const { inline } = choice;
        return {
            script: { inline },
            parameters: {},
            effect: inline.effect,
            fields: inline.fields,
            effectPath: `${path}.inline.effect`,
        };
    }
    const named = readScriptName(input, path, context);
    if (named === INVALID) {
        return INVALID;
    }
    const { name, declaration } = named;
    return {
        script: name,
        parameters: declaration.parameters,
        effect: declaration.effect,
        fields: declaration.fields,
        effectPath: path,
    };
}
