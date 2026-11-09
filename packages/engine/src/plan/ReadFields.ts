import { PlanErrorCode, isNonArrayObject } from "@revisum/contracts";
import type { ReadableInput } from "../decoding/ReadableCopy.ts";
import { INVALID, readRecord, type Issues, type Parsed } from "./parse/ReadRecord.ts";

// Reads one field's value. A bad value must give INVALID and record an issue at `path` in `issues`.
// The type can't require that: a function can't be typed to record anything, and Parsed<unknown>
// collapses to unknown, so a FieldReader<unknown> may return anything at all. A reader that probes
// its input's keys takes a ReadableInput, and is then read only from a readable copy.
export type FieldReader<Value, Input = unknown> = (
    input: Input,
    path: string,
    issues: Issues,
) => Parsed<Value>;

// A field that may be left out, and is then left out of what readFields returns too. When the field
// is there, its reader has the same duty as any other.
export type OptionalField<Value, Input = unknown> = {
    readonly readWhenPresent: FieldReader<Value, Input>;
};

type Field<Input = unknown> = FieldReader<unknown, Input> | OptionalField<unknown, Input>;

type FieldTable<Input = unknown> = Readonly<Record<string, Field<Input>>>;

type RequiredKeys<Table extends FieldTable<never>> = {
    [Key in keyof Table]: Table[Key] extends FieldReader<unknown, never> ? Key : never;
}[keyof Table];

type ValueOf<Field> =
    Field extends FieldReader<infer Value, never>
        ? Value
        : Field extends OptionalField<infer Value, never>
          ? Value
          : never;

export type FieldValues<Table extends FieldTable<never>> = {
    readonly [Key in RequiredKeys<Table>]: ValueOf<Table[Key]>;
} & {
    readonly [Key in Exclude<keyof Table, RequiredKeys<Table>>]?: ValueOf<Table[Key]>;
};

export const optionalField = <Value>(
    readWhenPresent: FieldReader<Value>,
): OptionalField<Value> => ({
    readWhenPresent,
});

const isField = (value: unknown): value is Field =>
    typeof value === "function" ||
    (isNonArrayObject(value) && Object.hasOwn(value, "readWhenPresent"));

// `{ __proto__: reader }` in an object literal sets the table's prototype instead of a key. Its type
// still names a field, exactly as `{ ["__proto__"]: reader }` does, so the type can't refuse one and
// keep the other: both mean the field __proto__. JavaScript keeps no position for the first form,
// so that field comes last.
const fieldsOf = (table: FieldTable): readonly (readonly [string, Field])[] => {
    const prototype: unknown = Object.getPrototypeOf(table);
    return isField(prototype)
        ? [...Object.entries(table), ["__proto__", prototype]]
        : Object.entries(table);
};

// A plain object holding exactly the fields `table` names, each read by its reader. The record is
// checked first, as by readRecord, with the same codes and paths, and a record that fails stops
// there. Otherwise every field is read, in the table's order, so that every field's issues are
// reported, in that order, under `path.field`. The result's keys follow the table's order too, not
// the input's. Missing fields are reported in `requiredOrder` when given, such as the grammar list
// a table is checked against, and otherwise in the table's order.
export function readFields<Table extends FieldTable<ReadableInput>>(
    input: ReadableInput,
    path: string,
    issues: Issues,
    table: Table,
    requiredOrder?: readonly RequiredKeys<Table>[],
): Parsed<FieldValues<Table>>;
export function readFields<Table extends FieldTable>(
    input: unknown,
    path: string,
    issues: Issues,
    table: Table,
    requiredOrder?: readonly RequiredKeys<Table>[],
): Parsed<FieldValues<Table>>;
export function readFields(
    input: unknown,
    path: string,
    issues: Issues,
    table: FieldTable,
    requiredOrder?: readonly string[],
): Parsed<Readonly<Record<string, unknown>>> {
    const entries = fieldsOf(table);
    const required =
        requiredOrder ??
        entries.flatMap(([key, field]) => (typeof field === "function" ? [key] : []));
    const allowed = entries.map(([key]) => key);
    const fields = readRecord(input, path, issues, allowed, required);
    if (fields === INVALID) {
        return INVALID;
    }

    const before = issues.length;
    const read = entries.flatMap(([key, field]): (readonly [string, unknown])[] => {
        if (typeof field !== "function" && !Object.hasOwn(fields, key)) {
            return [];
        }
        const readField = typeof field === "function" ? field : field.readWhenPresent;
        const fieldPath = `${path}.${key}`;
        const issuesBeforeField = issues.length;
        const value = readField(fields[key], fieldPath, issues);
        // A rejection must give its reason, even when the reader doesn't.
        if (value === INVALID && issues.length === issuesBeforeField) {
            issues.push({ code: PlanErrorCode.WrongType, path: fieldPath });
        }
        return [[key, value]];
    });
    const hasInvalidField = read.some(([, value]) => value === INVALID);
    return hasInvalidField || issues.length !== before ? INVALID : Object.fromEntries(read);
}
