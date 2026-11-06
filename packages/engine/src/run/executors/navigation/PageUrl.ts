// The URL a navigate step or a second tab opens, once its values are known.
import {
    failure,
    StepCode,
    StepType,
    success,
    type AllowedUrl,
    type PathTemplate,
    type Result,
} from "@revisum/contracts";
import { resolvePathTemplate } from "../../../run-values.ts";
import { isAllowedNow } from "../../GuardFor.ts";
import type { RunContext } from "../../RunContext.ts";

// A path template's values are only known now, so the runtime guard checks the final URL. A URL the
// plan wrote out was judged before the run.
function pathOf(
    url: AllowedUrl | PathTemplate,
    index: number,
    context: RunContext,
): Result<string, StepCode> {
    if (typeof url === "string") {
        return success(url);
    }
    const resolved = resolvePathTemplate(url, context.values, context.cleared.project);
    if (!resolved.ok) {
        return resolved;
    }
    const isAllowed = isAllowedNow(
        { type: StepType.Navigate, url: resolved.value },
        index,
        context,
    );
    return isAllowed ? success(resolved.value) : failure(StepCode.PolicyDenied);
}

// The page's URL on the run's base URL. It is always on one of the project's origins: the run's
// base URL is, or the run is refused before it starts; a URL the plan wrote out on another origin is
// denied before the run; and a path template's values cannot change its origin.
export function pageUrl(
    url: AllowedUrl | PathTemplate,
    index: number,
    context: RunContext,
): Result<URL, StepCode> {
    const path = pathOf(url, index, context);
    if (!path.ok) {
        return path;
    }
    return success(new URL(path.value, context.inputs.baseUrl));
}
