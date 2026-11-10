// What an in-page function reports as JSON is outside data: the page's own scripts may have changed
// what the browser hands back. These read it a field at a time.
import { MalformedBrowserReply } from "../../connection/MalformedBrowserReply.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The fields of a value that is an object, or none for any other value.
export const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> =>
    isRecord(value) ? value : {};

// The fields of a report, and where one of another shape is, for the failure.
export function reportedFields(text: string, source: string): Readonly<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
        throw new MalformedBrowserReply(source, "report");
    }
    return parsed;
}

export function reportedBoolean(
    fields: Readonly<Record<string, unknown>>,
    name: string,
    source: string,
): boolean {
    const value = fields[name];
    if (typeof value !== "boolean") {
        throw new MalformedBrowserReply(source, `report.${name}`);
    }
    return value;
}

// A field that is text or null. Anything else says the report cannot be read.
export function reportedTextOrNull(
    fields: Readonly<Record<string, unknown>>,
    name: string,
    source: string,
): string | null {
    const value = fields[name];
    if (typeof value === "string" || value === null) {
        return value;
    }
    throw new MalformedBrowserReply(source, `report.${name}`);
}

// A field that is a box or null. Anything else says the report cannot be read.
export function reportedBoxOrNull(
    fields: Readonly<Record<string, unknown>>,
    name: string,
    source: string,
): ReturnType<typeof boxOf> {
    const value = fields[name];
    const box = boxOf(value);
    if (box !== null || value === null) {
        return box;
    }
    throw new MalformedBrowserReply(source, `report.${name}`);
}

// A box of four numbers, or null for anything else.
export function boxOf(value: unknown): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
} | null {
    const { x, y, width, height } = fieldsOf(value);
    if (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof width === "number" &&
        typeof height === "number"
    ) {
        return { x, y, width, height };
    }
    return null;
}
