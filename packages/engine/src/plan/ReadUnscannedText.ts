// Text checked for what a person could not read, but not searched for literal secrets. The project
// file is trusted and reviewed as code, so its parsers read text with this. A plan's text must be
// searched, so of the plan's own files only ReadWrittenText, which searches what this returns, may
// import it.
import type { SafeText } from "@revisum/contracts";
import { brand } from "../brand.ts";
import { INVALID, isUnsafeText, type Issues, type Parsed } from "./plan-decoders.ts";

export function readUnscannedText(
    input: unknown,
    path: string,
    issues: Issues,
    maximumLength: number,
    minimumLength = 1,
): Parsed<SafeText> {
    if (typeof input !== "string") {
        issues.push({ code: "wrong_type", path });
        return INVALID;
    }
    if (input.length < minimumLength) {
        issues.push({ code: "empty", path });
        return INVALID;
    }
    if (input.length > maximumLength) {
        issues.push({ code: "too_long", path });
        return INVALID;
    }
    if (isUnsafeText(input)) {
        issues.push({ code: "unsafe_text", path });
        return INVALID;
    }
    return brand<string, "SafeText">(input);
}
