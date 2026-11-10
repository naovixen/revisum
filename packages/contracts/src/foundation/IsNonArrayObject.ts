// Any object but an array: a Date, a Map or a class instance passes, so this alone never accepts a
// value as data. It tells a value's forms apart before a stricter decoder reads the form it picked,
// or looks inside what JSON.parse just returned, which can hold nothing else. To accept only what
// JSON can write, use isPlainObject.
export const isNonArrayObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
