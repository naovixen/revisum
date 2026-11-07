import { isNonArrayObject } from "./IsNonArrayObject.ts";

// Only what an object literal or JSON.parse can make, or an object with no prototype at all. A Date,
// a Map or a class instance is refused, so its inherited behaviour can't be mistaken for fields. A
// proxy that throws when asked its prototype is refused too, but a field read afterwards can still
// throw, so a parser reads a copy of its input taken once, not the input itself.
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!isNonArrayObject(value)) {
        return false;
    }
    try {
        const prototype: unknown = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}
