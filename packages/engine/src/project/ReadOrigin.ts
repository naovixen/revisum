// Reads an origin a person declared in the project file.
import { parseOrigin, type Origin } from "@revisum/contracts";
import { INVALID, type Issues, type Parsed } from "../plan/parse/ReadRecord.ts";

export function readOrigin(input: unknown, path: string, issues: Issues): Parsed<Origin> {
    const origin = parseOrigin(input);
    if (!origin.ok) {
        issues.push({ code: origin.error, path });
        return INVALID;
    }
    return origin.value;
}
