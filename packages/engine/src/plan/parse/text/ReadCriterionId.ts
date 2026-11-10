// The acceptance criterion an assertion checks, as a plan names it.
import { PlanErrorCode, type CriterionId } from "@revisum/contracts";
import { brand } from "../../../foundation/Brand.ts";
import { looksLikeCredential } from "../../../decoding/LooksLikeCredential.ts";
import type { Parsed } from "../../../decoding/ReadRecord.ts";
import { CRITERION_FIELD, CRITERION_ID } from "../../../decoding/PlanFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";

// A criterion id as a plan may write it, such as "AC-3", or undefined when the text is not one. The
// draft command reads a spec's criterion ids with it, so a draft names them as a plan can.
export function criterionIdFrom(text: string): CriterionId | undefined {
    return CRITERION_ID.test(text) && !looksLikeCredential(text)
        ? brand<string, "CriterionId">(text)
        : undefined;
}

// Every assertion names the acceptance criterion it checks. Without one, a passing check would
// trace to nothing, so a missing or empty id is vacuous, which a field table can't say: there a
// missing field is missing_field.
export function readCriterionId(
    step: { readonly [CRITERION_FIELD]?: unknown },
    stepPath: string,
    context: ParseContext,
): Parsed<CriterionId> {
    const path = `${stepPath}.${CRITERION_FIELD}`;
    const value = step[CRITERION_FIELD];
    if (!Object.hasOwn(step, CRITERION_FIELD) || value === "") {
        return refuse(context.issues, PlanErrorCode.Vacuous, path);
    }
    if (typeof value !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    if (!CRITERION_ID.test(value)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    if (looksLikeCredential(value)) {
        return refuse(context.issues, PlanErrorCode.LiteralSecret, path);
    }
    return brand<string, "CriterionId">(value);
}
