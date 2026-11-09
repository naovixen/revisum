// Small "parse, don't validate" helpers for outside input. Each helper either returns a precise
// value or records a PlanError and returns INVALID. Errors carry a code and a JSON path, never
// the offending value, so hostile or private text is never echoed back.
import { PlanErrorCode, isPlainObject, type PlanError, type SafeText } from "@revisum/contracts";
import type { NonEmptyList } from "../../decoding/NonEmptyList.ts";
import {
    readOneLevel,
    type ReadableInput,
    type ReadableRecord,
} from "../../decoding/ReadableCopy.ts";
import { brand } from "../../foundation/Brand.ts";
import { sha256 } from "../../foundation/Sha256.ts";
import { looksLikeCredential } from "../LooksLikeCredential.ts";
import { UNSAFE_TEXT_CHARACTERS } from "../schema/PlanFields.ts";

export const INVALID: unique symbol = Symbol("invalid");
export type Parsed<Value> = Value | typeof INVALID;

export type Issues = PlanError[];

const CONTROL_OR_BIDIRECTIONAL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const SCRIPT_LIKE: readonly RegExp[] = [
    // The spaces before and after "/" are one group, so a long run of spaces is read only one way.
    /<\s*(?:\/\s*)?(script|iframe|object|embed|svg|math|style|link|meta|base)\b/i,
    /\b(javascript|vbscript)\s*:/i,
    /\bon[a-z]+\s*=/i,
    /data\s*:\s*text\/html/i,
];

const UNSAFE_TEXT_CHARACTER = new RegExp(`[${UNSAFE_TEXT_CHARACTERS}]`);

const looksLikeScript = (value: string): boolean =>
    SCRIPT_LIKE.some((pattern) => pattern.test(value));

// True for plan or project text that a person approving it could not read for what it holds: a
// character from UNSAFE_TEXT_CHARACTERS, anything that looks like script, or half of a UTF-16
// surrogate pair on its own, which no UTF-8 file can hold, so the plan would change when saved.
export const isUnsafeText = (value: string): boolean =>
    UNSAFE_TEXT_CHARACTER.test(value) || looksLikeScript(value) || !value.isWellFormed();

// The rule for text a run meets, such as a page's text. Pages hold marks and invisible characters
// a plan has no reason to, and refusing them would fail runs over what no one wrote into a plan.
const isUnsafeRunTimeText = (value: string): boolean =>
    CONTROL_OR_BIDIRECTIONAL.test(value) || looksLikeScript(value) || !value.isWellFormed();

// The same characters apart from tab and line breaks, which prose such as release notes needs.
const CONTROL_OR_BIDIRECTIONAL_IN_PROSE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

// The rule for multi-line prose: as for run-time text, but tabs and line breaks are allowed.
export const isUnsafeProse = (value: string): boolean =>
    CONTROL_OR_BIDIRECTIONAL_IN_PROSE.test(value) ||
    SCRIPT_LIKE.some((pattern) => pattern.test(value));

// Characters an editor may show as a line break, though only LF splits a source into script lines
// in the readable plan format: next line (U+0085), line separator and paragraph separator.
const HIDDEN_LINE_BREAK = /[\u0085\u2028\u2029]/;

// The rule for a script's source text, which is code by design, so looking like script is no
// fault: control or bidirectional-override characters other than tabs and line breaks, a hidden
// line break that would make one script line look like several, or half of a surrogate pair, are
// refused.
export const isUnsafeSource = (value: string): boolean =>
    CONTROL_OR_BIDIRECTIONAL_IN_PROSE.test(value) ||
    HIDDEN_LINE_BREAK.test(value) ||
    !value.isWellFormed();

// True when `input` is one of `values`, narrowing it to that union.
export const isOneOf = <Value extends string>(
    values: readonly Value[],
    input: string,
): input is Value => values.some((value) => value === input);

// True for a list with a place no value was ever put in. Nothing written as JSON has one, and
// walking the list would pass over it without reading anything there.
export const hasHoles = (list: readonly unknown[]): boolean => {
    for (let index = 0; index < list.length; index += 1) {
        if (!Object.hasOwn(list, index)) {
            return true;
        }
    }
    return false;
};

// A plain object whose keys are all in `allowed` and include every key in `required`. A readable
// copy's record is one, as read.
export function readRecord(
    input: ReadableInput,
    path: string,
    issues: Issues,
    allowed: readonly string[],
    required?: readonly string[],
): Parsed<ReadableRecord>;
export function readRecord(
    input: unknown,
    path: string,
    issues: Issues,
    allowed: readonly string[],
    required?: readonly string[],
): Parsed<Readonly<Record<string, unknown>>>;
export function readRecord(
    input: unknown,
    path: string,
    issues: Issues,
    allowed: readonly string[],
    required: readonly string[] = allowed,
): Parsed<Readonly<Record<string, unknown>>> {
    const fields = peekRecord(input, path, issues);
    if (fields === INVALID) {
        return INVALID;
    }
    const before = issues.length;
    for (const key of Object.keys(fields)) {
        if (allowed.includes(key)) {
            continue;
        }
        // Errors are kept and shown, so a key shaped like a credential is reported by where it sits.
        issues.push(
            looksLikeCredential(key)
                ? { code: PlanErrorCode.LiteralSecret, path }
                : { code: PlanErrorCode.UnknownField, path: `${path}.${key}` },
        );
    }
    for (const key of required) {
        if (!Object.hasOwn(fields, key)) {
            issues.push({ code: PlanErrorCode.MissingField, path: `${path}.${key}` });
        }
    }
    return issues.length === before ? fields : INVALID;
}

// A plain object with any keys, to read a discriminant before the strict check. What it returns is
// a copy of the record's own data, read once, so reading its fields can't throw; a record that
// can't be read so is not_object. A readable copy's record is itself.
export function peekRecord(
    input: ReadableInput,
    path: string,
    issues: Issues,
): Parsed<ReadableRecord>;
export function peekRecord(
    input: unknown,
    path: string,
    issues: Issues,
): Parsed<Readonly<Record<string, unknown>>>;
export function peekRecord(
    input: unknown,
    path: string,
    issues: Issues,
): Parsed<Readonly<Record<string, unknown>>> {
    const fields = readOneLevel(input);
    if (!isPlainObject(fields)) {
        issues.push({ code: PlanErrorCode.NotObject, path });
        return INVALID;
    }
    return fields;
}

// Text made at run time, such as a generated value, branded only once it passes the safety rules
// for run-time text and its length limit. Undefined means it failed them.
export function runTimeText(value: string, maximumLength: number): SafeText | undefined {
    return value.length <= maximumLength && !isUnsafeRunTimeText(value)
        ? brand<string, "SafeText">(value)
        : undefined;
}

// Text from outside input that is kept whatever it holds, such as a test title in a suite's report:
// the text itself when it passes the safety rules and length limit, otherwise "sha256:" and its
// digest, which always does, so unsafe text is dropped without losing which text it was.
export function runTimeTextOrDigest(value: string, maximumLength: number): SafeText {
    return (
        runTimeText(value, maximumLength) ?? brand<string, "SafeText">(`sha256:${sha256(value)}`)
    );
}

export function readOneOf<Value extends string>(
    input: unknown,
    path: string,
    issues: Issues,
    values: readonly Value[],
    code: PlanErrorCode = PlanErrorCode.UnknownValue,
): Parsed<Value> {
    if (typeof input !== "string") {
        issues.push({ code: PlanErrorCode.WrongType, path });
        return INVALID;
    }
    const found = values.find((value) => value === input);
    if (found === undefined) {
        issues.push({ code, path });
        return INVALID;
    }
    return found;
}

// A list of at most `maximumLength` items and at least `minimumLength`, which is 1 unless given, so
// a list read without one holds at least one item. A readable copy's items are readable.
export function readList(
    input: ReadableInput,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength?: 1,
): Parsed<NonEmptyList<ReadableInput>>;
export function readList(
    input: ReadableInput,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength: number,
): Parsed<readonly ReadableInput[]>;
export function readList(
    input: unknown,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength?: 1,
): Parsed<NonEmptyList<unknown>>;
export function readList(
    input: unknown,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength: number,
): Parsed<readonly unknown[]>;
export function readList(
    input: unknown,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength = 1,
): Parsed<readonly unknown[]> {
    // A copy of the list, read once, so walking it can't throw; a list that can't be read so is wrong_type.
    const read = readOneLevel(input);
    if (!Array.isArray(read)) {
        issues.push({ code: PlanErrorCode.WrongType, path });
        return INVALID;
    }
    const list: readonly unknown[] = read;
    if (list.length < minimumLength) {
        issues.push({ code: PlanErrorCode.Empty, path });
        return INVALID;
    }
    if (list.length > maximumLength) {
        issues.push({ code: PlanErrorCode.TooLarge, path });
        return INVALID;
    }
    if (hasHoles(list)) {
        issues.push({ code: PlanErrorCode.WrongType, path });
        return INVALID;
    }
    return list;
}

export function readInteger(
    input: unknown,
    path: string,
    issues: Issues,
    lowest: number,
    highest: number,
): Parsed<number> {
    if (typeof input !== "number" || !Number.isInteger(input)) {
        issues.push({ code: PlanErrorCode.WrongType, path });
        return INVALID;
    }
    if (input < lowest || input > highest) {
        issues.push({ code: PlanErrorCode.UnknownValue, path });
        return INVALID;
    }
    return input;
}

// True when no helper returned INVALID. Narrows a tuple of parsed values.
export const allValid = <Values extends readonly unknown[]>(
    values: Values,
): values is { [Index in keyof Values]: Exclude<Values[Index], typeof INVALID> } =>
    values.every((value) => value !== INVALID);
