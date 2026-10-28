// Small "parse, don't validate" helpers for outside input. Each helper either returns a precise
// value or records a PlanError and returns INVALID. Errors carry a code and a JSON path, never
// the offending value, so hostile or private text is never echoed back.
import type { SafeText } from '@revisum/contracts';
import { brand } from '../brand.ts';

export const PLAN_ERROR_CODES = [
  'not_object', 'unknown_field', 'missing_field', 'wrong_type', 'unknown_step',
  'unknown_value', 'invalid_url', 'scheme_not_allowed', 'origin_not_allowed',
  'target_not_in_matrix', 'unsafe_text', 'too_large', 'too_long', 'duplicate',
  'version_unsupported', 'empty',
  // A check that would pass on anything, such as an expected text that is empty.
  'vacuous',
  // A version 1 assertion that the migration's mapping gives no criterion id.
  'no_criterion_id',
  // A secret written into the plan: literal text in a sensitive field, credential-shaped text, or
  // saved storage state itself. A plan names secrets with { secretName }.
  'literal_secret',
  // A reference to a run value that no earlier part of the plan defines.
  'undefined_value',
  // A position on the locator of a check that counts matches (countEquals or absent), where
  // picking one element would make the count meaningless.
  'position_not_allowed',
  // A step where the language does not allow it, such as a newTab inside a frame or another newTab.
  'misplaced_step',
  // A call declaration that writes a parameter into a string, when the parameter's type could
  // hold a quote, a space or a separator and so change what the string says.
  'unsafe_interpolation',
  // A call declaration that sets a header deciding where or how a request travels, such as host.
  'header_not_allowed',
] as const;
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];

export type PlanError = { readonly code: PlanErrorCode; readonly path: string };

export const INVALID: unique symbol = Symbol('invalid');
export type Parsed<Value> = Value | typeof INVALID;

export type Issues = PlanError[];

const CONTROL_OR_BIDIRECTIONAL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const SCRIPT_LIKE: readonly RegExp[] = [
  /<\s*\/?\s*(script|iframe|object|embed|svg|math|style|link|meta|base)\b/i,
  /\b(javascript|vbscript)\s*:/i,
  /\bon[a-z]+\s*=/i,
  /data\s*:\s*text\/html/i,
];

// True for text with control or bidirectional-override characters, anything that looks like
// script, or half of a UTF-16 surrogate pair on its own, which no UTF-8 file can hold, so the plan
// would change when saved.
export const isUnsafeText = (value: string): boolean =>
  CONTROL_OR_BIDIRECTIONAL.test(value) || SCRIPT_LIKE.some((pattern) => pattern.test(value)) || !value.isWellFormed();

// The same characters apart from tab and line breaks, which prose such as release notes needs.
const CONTROL_OR_BIDIRECTIONAL_IN_PROSE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

// The rule for multi-line prose: as isUnsafeText, but tabs and line breaks are allowed.
export const isUnsafeProse = (value: string): boolean =>
  CONTROL_OR_BIDIRECTIONAL_IN_PROSE.test(value) || SCRIPT_LIKE.some((pattern) => pattern.test(value));

// True when `input` is one of `values`, narrowing it to that union.
export const isOneOf = <Value extends string>(values: readonly Value[], input: string): input is Value =>
  values.some((value) => value === input);

// A plain object whose keys are all in `allowed` and include every key in `required`.
export function readRecord(
  input: unknown, path: string, issues: Issues,
  allowed: readonly string[], required: readonly string[] = allowed,
): Parsed<Readonly<Record<string, unknown>>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push({ code: 'not_object', path });
    return INVALID;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push({ code: 'not_object', path });
    return INVALID;
  }
  const before = issues.length;
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) issues.push({ code: 'unknown_field', path: `${path}.${key}` });
  }
  const fields = input as Record<string, unknown>;
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) issues.push({ code: 'missing_field', path: `${path}.${key}` });
  }
  return issues.length === before ? fields : INVALID;
}

// A plain object with any keys, to read a discriminant before the strict check.
export function peekRecord(input: unknown, path: string, issues: Issues): Parsed<Readonly<Record<string, unknown>>> {
  return readRecord(input, path, issues, typeof input === 'object' && input !== null ? Object.keys(input) : [], []);
}

export function readText(
  input: unknown, path: string, issues: Issues, maximumLength: number, minimumLength = 1,
): Parsed<SafeText> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input.length < minimumLength) { issues.push({ code: 'empty', path }); return INVALID; }
  if (input.length > maximumLength) { issues.push({ code: 'too_long', path }); return INVALID; }
  if (isUnsafeText(input)) { issues.push({ code: 'unsafe_text', path }); return INVALID; }
  return brand<string, 'SafeText'>(input);
}

// Text made at run time, such as a generated value, branded only once it passes the same safety
// rules and length limit as text in a plan. Undefined means it failed them.
export function runTimeText(value: string, maximumLength: number): SafeText | undefined {
  return value.length <= maximumLength && !isUnsafeText(value) ? brand<string, 'SafeText'>(value) : undefined;
}

export function readOneOf<Value extends string>(
  input: unknown, path: string, issues: Issues, values: readonly Value[], code: PlanErrorCode = 'unknown_value',
): Parsed<Value> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = values.find((value) => value === input);
  if (found === undefined) { issues.push({ code, path }); return INVALID; }
  return found;
}

export function readList(
  input: unknown, path: string, issues: Issues, maximumLength: number, minimumLength = 1,
): Parsed<readonly unknown[]> {
  if (!Array.isArray(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input.length < minimumLength) { issues.push({ code: 'empty', path }); return INVALID; }
  if (input.length > maximumLength) { issues.push({ code: 'too_large', path }); return INVALID; }
  return input;
}

export function readInteger(input: unknown, path: string, issues: Issues, lowest: number, highest: number): Parsed<number> {
  if (typeof input !== 'number' || !Number.isInteger(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input < lowest || input > highest) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return input;
}

// True when no helper returned INVALID. Narrows a tuple of parsed values.
export const allValid = <Values extends readonly unknown[]>(
  values: Values,
): values is { [Index in keyof Values]: Exclude<Values[Index], typeof INVALID> } => values.every((value) => value !== INVALID);
