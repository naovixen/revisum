// A field already read and checked, such as the discriminant a decoder chose its fields by, so a
// field table can name it without reading it again.
import type { FieldReader } from "../ReadFields.ts";

export const knownField =
    <const Value>(value: Value): FieldReader<Value> =>
    () =>
        value;
