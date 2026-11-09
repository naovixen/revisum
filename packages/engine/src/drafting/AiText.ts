// Text an AI writer returns is outside input. parseAiText is the one way it becomes AiText, which
// is only ever stored as a suggestion beside the deterministic output, never in its place. It uses
// the plan parser's text rules and codes, but accepts tabs and line breaks, which prose needs.
import {
    PlanErrorCode,
    failure,
    success,
    type Brand,
    type Result,
    type PlanError,
} from "@revisum/contracts";
import { brand } from "../foundation/Brand.ts";
import { isUnsafeProse } from "../decoding/ReadRecord.ts";

export type AiText = Brand<string, "AiText">;

// Errors name the problem, never the text, so a hostile suggestion is not echoed back.
export function parseAiText(input: unknown, maximumCharacters: number): Result<AiText, PlanError> {
    if (typeof input !== "string") {
        return failure({ code: PlanErrorCode.WrongType, path: "$" });
    }
    if (input.length === 0) {
        return failure({ code: PlanErrorCode.Empty, path: "$" });
    }
    // Length first, so an enormous text is refused before any pattern runs over it.
    if (input.length > maximumCharacters) {
        return failure({ code: PlanErrorCode.TooLong, path: "$" });
    }
    if (isUnsafeProse(input)) {
        return failure({ code: PlanErrorCode.UnsafeText, path: "$" });
    }
    return success(brand<string, "AiText">(input));
}
