import { INVALID, readRecord, type Issues, type Parsed } from "./plan-decoders.ts";

// Reads one field's value, recording what is wrong with it at `path` in `issues`.
export type FieldReader<Value> = (input: unknown, path: string, issues: Issues) => Parsed<Value>;

// A field that may be left out, and is then left out of what readFields returns too.
export type OptionalField<Value> = { readonly readWhenPresent: FieldReader<Value> };

type FieldTable = Readonly<Record<string, FieldReader<unknown> | OptionalField<unknown>>>;

type RequiredKeys<Table extends FieldTable> = {
    [Key in keyof Table]: Table[Key] extends FieldReader<unknown> ? Key : never;
}[keyof Table];

type ValueOf<Field> =
    Field extends FieldReader<infer Value>
        ? Value
        : Field extends OptionalField<infer Value>
          ? Value
          : never;

export type FieldValues<Table extends FieldTable> = {
    readonly [Key in RequiredKeys<Table>]: ValueOf<Table[Key]>;
} & {
    readonly [Key in Exclude<keyof Table, RequiredKeys<Table>>]?: ValueOf<Table[Key]>;
};

export const optionalField = <Value>(
    readWhenPresent: FieldReader<Value>,
): OptionalField<Value> => ({
    readWhenPresent,
});

// A plain object holding exactly the fields `table` names, each read by its reader. The record is
// checked first, as by readRecord, with the same codes and paths, and a record that fails stops
// there. Otherwise every field is read, in the table's order, so that every field's issues are
// reported, in that order, under `path.field`.
export function readFields<Table extends FieldTable>(
    input: unknown,
    path: string,
    issues: Issues,
    table: Table,
): Parsed<FieldValues<Table>>;
export function readFields(
    input: unknown,
    path: string,
    issues: Issues,
    table: FieldTable,
): Parsed<Readonly<Record<string, unknown>>> {
    const entries = Object.entries(table);
    const required = entries.flatMap(([key, field]) => (typeof field === "function" ? [key] : []));
    const fields = readRecord(input, path, issues, Object.keys(table), required);
    if (fields === INVALID) {
        return INVALID;
    }

    const before = issues.length;
    const read = entries.flatMap(([key, field]): (readonly [string, unknown])[] => {
        if (typeof field !== "function" && !Object.hasOwn(fields, key)) {
            return [];
        }
        const readField = typeof field === "function" ? field : field.readWhenPresent;
        return [[key, readField(fields[key], `${path}.${key}`, issues)]];
    });
    const hasInvalidField = read.some(([, value]) => value === INVALID);
    return hasInvalidField || issues.length !== before ? INVALID : Object.fromEntries(read);
}
