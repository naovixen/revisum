// A field table holding exactly the fields a grammar list names, required and optional as it lists
// them. The published JSON Schema is built from the same lists, so a decoder whose table
// `satisfies` this can't drift from the schema. The type can't see order: a table must still name
// its required fields in the list's order, which is the order missing fields are reported in.
import type { FieldReader, OptionalField } from "../ReadFields.ts";

export type ListedFields<Required extends string, Optional extends string = never> = {
    readonly [Key in Required]: FieldReader<unknown>;
} & { readonly [Key in Optional]: OptionalField<unknown> };
