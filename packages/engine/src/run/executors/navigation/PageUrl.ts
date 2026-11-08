// The URL a navigate step or a second tab opens, once its values are known.
import {
    failure,
    stepFailed,
    StepType,
    success,
    type AllowedUrl,
    type PathTemplate,
    type Result,
    type StepRecord,
} from "@revisum/contracts";
import { resolvePathTemplate } from "../../../run-values.ts";
import { denialNow } from "../../ActGuarded.ts";
import type { RunContext } from "../../RunContext.ts";
import { deniedStep, type DeniedStep } from "../StepExecutor.ts";

// What resolving a page's URL needs of the run.
type PageUrlContext = Pick<RunContext, "values" | "cleared" | "gate" | "inputs">;

// Why a page's URL cannot be opened: the step's failure, or the runtime guard's denial.
type UrlRefused = StepRecord | DeniedStep;

// A path template's values are only known now, so the runtime guard checks the final URL. A URL the
// plan wrote out was judged before the run.
function pathOf(
    url: AllowedUrl | PathTemplate,
    index: number,
    context: PageUrlContext,
): Result<string, UrlRefused> {
    if (typeof url === "string") {
        return success(url);
    }
    const resolved = resolvePathTemplate(url, context.values, context.cleared.project);
    if (!resolved.ok) {
        return failure(stepFailed(resolved.error));
    }
    const denial = denialNow({ type: StepType.Navigate, url: resolved.value }, index, context);
    return denial === undefined ? success(resolved.value) : failure(deniedStep(denial));
}

// The page's URL on the run's base URL. It is always on one of the project's origins: the run's
// base URL is, or the run is refused before it starts; a URL the plan wrote out on another origin is
// denied before the run; and a path template's values cannot change its origin.
export function pageUrl(
    url: AllowedUrl | PathTemplate,
    index: number,
    context: PageUrlContext,
): Result<URL, UrlRefused> {
    const path = pathOf(url, index, context);
    if (!path.ok) {
        return path;
    }
    return success(new URL(path.value, context.inputs.baseUrl));
}
