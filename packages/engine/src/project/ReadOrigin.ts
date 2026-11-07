// Reads an origin a person declared in the project file.
import type { Origin } from "@revisum/contracts";
import { brand } from "../brand.ts";
import { INVALID, type Issues, type Parsed } from "../plan/plan-decoders.ts";

// The origin of an http or https URL the caller has already checked.
export const originOfUrl = (url: URL): Origin => brand<string, "Origin">(url.origin);

// An http or https origin with no path, written exactly as the URL standard serialises it.
export function readOrigin(input: unknown, path: string, issues: Issues): Parsed<Origin> {
    if (typeof input !== "string") {
        issues.push({ code: "wrong_type", path });
        return INVALID;
    }
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        issues.push({ code: "invalid_url", path });
        return INVALID;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push({ code: "scheme_not_allowed", path });
        return INVALID;
    }
    if (url.origin !== input) {
        issues.push({ code: "invalid_url", path });
        return INVALID;
    }
    return brand<string, "Origin">(input);
}
