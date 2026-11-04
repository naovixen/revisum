// Any object but an array: a Date, a Map or a class instance passes. For telling a value's forms
// apart, or looking inside a reply, where a stricter decoder has the last word or the fields read
// are checked one by one. To accept only what JSON can write, use isPlainObject.
export const isNonArrayObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
