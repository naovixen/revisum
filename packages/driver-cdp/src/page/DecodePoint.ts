// A point the page reports, and comparing two.
import type { Point } from "./PageOperations.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Decodes the {x, y} JSON frameContentOffset (in-page/Actionability.ts) reports.
export function decodePoint(text: string): Point {
    const parsed: unknown = JSON.parse(text);
    const fields = isRecord(parsed) ? parsed : {};
    const { x, y } = fields;
    if (typeof x !== "number" || typeof y !== "number") {
        throw new Error("the frame offset is not a point");
    }
    return { x, y };
}

export const isSamePoint = (first: Point, second: Point): boolean =>
    first.x === second.x && first.y === second.y;
