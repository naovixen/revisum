// A field table holding exactly the fields a grammar list names, required and optional as it lists
// them. The published JSON Schema is built from the same lists, so a decoder whose table
// `satisfies` this can't drift from the schema. A type can't see the order of a table's keys, so a
// decoder passes the list itself to readFields too, and missing fields are reported in its order.
import type { FieldReader, OptionalField } from "../ReadFields.ts";

export type ListedFields<Required extends string, Optional extends string = never> = {
    readonly [Key in Required]: FieldReader<unknown>;
} & { readonly [Key in Optional]: OptionalField<unknown> };
