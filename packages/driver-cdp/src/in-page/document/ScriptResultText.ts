/// <reference lib="dom" />
// A page script's result.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// A page script's result written as JSON text, as ['text', text], or ['not-json'] when JSON cannot
// write it: undefined, a function or a symbol, or a value that is cyclic or holds a bigint. UTF-8
// never takes fewer bytes than the text has UTF-16 code units, so text longer than the byte limit
// in code units is over it in bytes too: only one code unit past the limit is sent back.
export function scriptResultText(value: unknown, maximumResultBytes: number): string[] {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        return ["not-json"];
    }
    let text: unknown;
    try {
        text = JSON.stringify(value);
    } catch {
        return ["not-json"];
    }
    if (typeof text !== "string") {
        return ["not-json"];
    }
    return [
        "text",
        text.length > maximumResultBytes ? text.slice(0, maximumResultBytes + 1) : text,
    ];
}
