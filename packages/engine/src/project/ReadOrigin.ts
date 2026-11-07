// Reads an origin a person declared in the project file.
import type { Origin, PlannerEndpoint } from "@revisum/contracts";
import { brand } from "../brand.ts";
import { INVALID, type Issues, type Parsed } from "../plan/plan-decoders.ts";

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

// The origin a planner endpoint's requests go to, which the egress proxy allows and nothing else.
// The project parser has checked the address is an http or https URL, so it always has one.
export const plannerOrigin = (endpoint: PlannerEndpoint): Origin =>
    brand<string, "Origin">(new URL(endpoint.url).origin);
