import { failure, success, type Result } from "./result.ts";
import { PlanErrorCode } from "./run-result/PlanError.ts";
import type { Origin } from "./target.ts";

export type OriginRefusal =
    | typeof PlanErrorCode.WrongType
    | typeof PlanErrorCode.InvalidUrl
    | typeof PlanErrorCode.SchemeNotAllowed;

const hasWebScheme = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

// An http or https origin with no path, written exactly as the URL standard serialises it. The only
// way to read an Origin, because the engine and the egress proxy must agree on what one is.
export function parseOrigin(value: unknown): Result<Origin, OriginRefusal> {
    if (typeof value !== "string") {
        return failure(PlanErrorCode.WrongType);
    }
    const url = URL.parse(value);
    if (url === null) {
        return failure(PlanErrorCode.InvalidUrl);
    }
    if (!hasWebScheme(url)) {
        return failure(PlanErrorCode.SchemeNotAllowed);
    }
    return url.origin === value ? success(value as Origin) : failure(PlanErrorCode.InvalidUrl);
}

// The origin of an http or https URL the caller has already checked.
export const originOfUrl = (url: URL): Origin => url.origin as Origin;
