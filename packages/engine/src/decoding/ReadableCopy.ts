// A parser's input is unknown, so it may be more than JSON.parse can make: a list with no
// prototype, a field whose getter throws or answers differently each time, or a proxy whose traps
// throw. Reading one of those could throw where the parser promises an answer. So the parsers read
// a copy taken once, here, holding only own data that was read safely, and every value that could
// not be read is replaced by UNREADABLE. UNREADABLE is no object, list, text or number, so each
// reader refuses it with the code it gives any value of the wrong form at that place.

export const UNREADABLE: unique symbol = Symbol("unreadable");

// An object that is neither a plain object nor a list, such as a Date or a class instance, is
// replaced by this: still an object, so a reader picks the same form for it as for the original
// and refuses it there, but holding no field, so nothing of the original is read.
class NotPlainData {}
const NOT_PLAIN_DATA: object = Object.freeze(new NotPlainData());

type Fields = Record<string, unknown>;

type OneLevel = unknown[] | Fields | typeof UNREADABLE | typeof NOT_PLAIN_DATA;

// Every copy made here, once frozen. A frozen copy holds only own data and can't be changed, so
// reading it again is safe, and a guard given one passes it on instead of copying it again.
const FROZEN_COPIES = new WeakSet<object>();

const frozenCopy = <Copy extends object>(copy: Copy): Copy => {
    Object.freeze(copy);
    FROZEN_COPIES.add(copy);
    return copy;
};

// True for a fresh list or plain object, whose values are still the originals' until filled.
const isUnfilledCopy = (copy: OneLevel): copy is unknown[] | Fields =>
    copy !== UNREADABLE && copy !== NOT_PLAIN_DATA;

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

// The own enumerable data fields, in order, or undefined when one of them is a getter or a setter.
// The own length of a list is kept apart, as JSON-shaped data has it but never enumerates it.
function ownDataOf(
    original: object,
): { readonly fields: (readonly [string, unknown])[]; readonly length: unknown } | undefined {
    const fields: (readonly [string, unknown])[] = [];
    let length: unknown;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
        const isData = Object.hasOwn(descriptor, "value");
        if (descriptor.enumerable !== true) {
            if (key === "length" && isData) {
                length = descriptor.value;
            }
            continue;
        }
        if (!isData) {
            return undefined;
        }
        fields.push([key, descriptor.value]);
    }
    return { fields, length };
}

function listOf(fields: readonly (readonly [string, unknown])[], length: unknown): OneLevel {
    if (typeof length !== "number") {
        return UNREADABLE;
    }
    const items: unknown[] = [];
    // Only the places that hold a value are filled, so a hole stays a hole for the reader to refuse.
    items.length = length;
    for (const [key, value] of fields) {
        const index = Number(key);
        if (ARRAY_INDEX.test(key) && index < length) {
            items[index] = value;
        }
    }
    return items;
}

function recordOf(fields: readonly (readonly [string, unknown])[], prototype: unknown): Fields {
    // fromEntries defines each field, so a field named __proto__ stays a field.
    const record: Fields = Object.fromEntries(fields);
    if (prototype === null) {
        Object.setPrototypeOf(record, null);
    }
    return record;
}

function copyOneLevelOf(original: object): OneLevel {
    try {
        const isList = Array.isArray(original);
        const prototype: unknown = Object.getPrototypeOf(original);
        if (!isList && prototype !== Object.prototype && prototype !== null) {
            return NOT_PLAIN_DATA;
        }
        const data = !isList || prototype === Array.prototype ? ownDataOf(original) : undefined;
        if (data === undefined) {
            return UNREADABLE;
        }
        return isList ? listOf(data.fields, data.length) : recordOf(data.fields, prototype);
    } catch {
        return UNREADABLE;
    }
}

// One level of `value`: a frozen list or plain object holding its own data, the same values
// inside, or UNREADABLE when it is neither a list nor a plain object, or can't be read safely. A
// copy made here already, by this or by readableCopy, is itself. A guard that narrows a value to a
// list or a record reads this, so what it lets through can be read.
export function readOneLevel(value: unknown): unknown {
    if (typeof value !== "object" || value === null || FROZEN_COPIES.has(value)) {
        return value;
    }
    const copy = copyOneLevelOf(value);
    return isUnfilledCopy(copy) ? frozenCopy(copy) : copy;
}

// A primitive JSON can't write is UNREADABLE too, so the copy can be written as JSON to be
// measured. undefined stays, as a field left out reads as undefined anyway.
const isWritablePrimitive = (value: unknown): boolean =>
    typeof value !== "bigint" && typeof value !== "symbol" && typeof value !== "function";

// A frozen copy of `input` at every depth, read one level at a time without recursion, so input
// nested thousands deep is copied too. A value met twice is copied once, so a cycle stays a cycle,
// as writing it out as JSON would refuse it before. A parser reads this once, at its edge, and
// every guard inside then passes the copy's lists and records on as they are.
export function readableCopy(input: unknown): unknown {
    const copies = new Map<object, OneLevel>();
    const unfilled: (unknown[] | Fields)[] = [];
    const copyOf = (value: unknown): unknown => {
        if (typeof value !== "object" || value === null) {
            return isWritablePrimitive(value) ? value : UNREADABLE;
        }
        const known = copies.get(value);
        if (known !== undefined) {
            return known;
        }
        const copy = copyOneLevelOf(value);
        copies.set(value, copy);
        if (isUnfilledCopy(copy)) {
            unfilled.push(copy);
        }
        return copy;
    };
    const top = copyOf(input);
    for (let next = unfilled.pop(); next !== undefined; next = unfilled.pop()) {
        if (Array.isArray(next)) {
            const items: unknown[] = next;
            for (const key of Object.keys(items)) {
                const index = Number(key);
                items[index] = copyOf(items[index]);
            }
            frozenCopy(items);
        } else {
            const fields: Fields = next;
            for (const key of Object.keys(fields)) {
                fields[key] = copyOf(fields[key]);
            }
            frozenCopy(fields);
        }
    }
    return top;
}
