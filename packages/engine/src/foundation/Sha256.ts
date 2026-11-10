// Canonical JSON and SHA-256: the same value always gives the same bytes and the same hash.
import { createHash } from "node:crypto";

// A map's entries in the order canonical JSON writes them, whatever order they were written in.
export const entriesInKeyOrder = <Value>(
    map: Readonly<Record<string, Value>>,
): readonly (readonly [string, Value])[] =>
    Object.entries(map).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

// Sorted keys, no whitespace; rejects values JSON cannot represent exactly.
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("non-finite number in canonical JSON");
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (typeof value === "object") {
        const entries = entriesInKeyOrder(value as Record<string, unknown>).filter(
            ([, entry]) => entry !== undefined,
        );
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
    }
    throw new TypeError(`unsupported value in canonical JSON: ${typeof value}`);
}

export const sha256 = (data: string | Uint8Array): string =>
    createHash("sha256").update(data).digest("hex");
