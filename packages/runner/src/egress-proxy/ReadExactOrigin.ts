import type { Origin } from "@revisum/contracts";

// A URL origin written exactly as the URL parser would write it, such as "http://127.0.0.1:4310".
export function readExactOrigin(value: unknown): Origin | null {
    return typeof value === "string" && URL.parse(value)?.origin === value
        ? (value as Origin)
        : null;
}
