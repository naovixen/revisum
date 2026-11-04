import { isNonArrayObject } from "./IsNonArrayObject.ts";

// Only what an object literal or JSON.parse can make, or an object with no prototype at all. A Date,
// a Map or a class instance is refused, so its inherited behaviour can't be mistaken for fields.
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!isNonArrayObject(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
