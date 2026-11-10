import {
    FillValueKind,
    stepFailed,
    StepOutcome,
    success,
    type FillValue,
    type PerformableFill,
    type ResolvedActionStep,
    type ResolvedLocator,
    type Result,
    type StepCode,
} from "@revisum/contracts";
import { canonicalJson } from "../../../foundation/Sha256.ts";
import type { RunFillStep } from "../../steps/RunStep.ts";
import { resolveFillText, resolveLocator } from "../../values/RunValues.ts";
import { actGuarded } from "../../ActGuarded.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepContext, StepExecutor, StepNeeds } from "../StepExecutor.ts";

// A fill as the runtime guard reads it, with the plan's secret reference, and as the driver performs
// it, with the secret preflight resolved for it, opaque, so the driver reveals it only as it types.
type ResolvedFill = { readonly guarded: ResolvedActionStep; readonly performable: PerformableFill };

// Values are substituted first, so the runtime guard and the driver see the final text.
function resolveFill(
    step: RunFillStep,
    context: Pick<RunContext, "values" | "cleared">,
): Result<ResolvedFill, StepCode> {
    const locator = resolveLocator(step.locator, context.values, context.cleared.project);
    if (!locator.ok) {
        return locator;
    }
    const { type } = step;
    if ("secret" in step) {
        const performable: PerformableFill = {
            type,
            locator: locator.value,
            value: { kind: FillValueKind.Secret, secret: step.secret },
        };
        return success({
            guarded: { type, locator: locator.value, value: step.value },
            performable,
        });
    }
    const text = resolveFillText(step.value, context.values, context.cleared.project);
    if (!text.ok) {
        return text;
    }
    const value: FillValue =
        typeof text.value === "string"
            ? { kind: FillValueKind.Text, text: text.value }
            : { kind: FillValueKind.Lines, lines: text.value.lines };
    return success({
        guarded: { type, locator: locator.value, value: text.value },
        performable: { type, locator: locator.value, value },
    });
}

// Keeps the fields whose last fill typed a secret, by their locator.
function markFilledField(
    fill: PerformableFill,
    secretFilledFields: Map<string, ResolvedLocator>,
): void {
    const key = canonicalJson(fill.locator);
    switch (fill.value.kind) {
        case FillValueKind.Secret:
            secretFilledFields.set(key, fill.locator);
            break;
        case FillValueKind.Text:
        case FillValueKind.Lines:
            secretFilledFields.delete(key);
            break;
    }
}

export const fillField: StepExecutor<
    RunFillStep,
    StepNeeds<"values" | "cleared" | "gate" | "index" | "document"> &
        Pick<StepContext, "secretFilledFields">
> = async (step, context) => {
    const fill = resolveFill(step, context);
    if (!fill.ok) {
        return stepFailed(fill.error);
    }
    // Marked before acting: a fill that fails part way may still have typed some of the secret.
    markFilledField(fill.value.performable, context.secretFilledFields);
    const acted = await actGuarded(fill.value.guarded, context.index, context, (guard) =>
        context.document.act(fill.value.performable, guard),
    );
    if (!acted.ok) {
        return acted.error;
    }
    return { outcome: StepOutcome.Passed };
};
