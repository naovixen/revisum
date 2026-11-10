import { stepFailed, StepOutcome } from "@revisum/contracts";
import { resolveInputStep, type InputStep } from "../../values/RunValues.ts";
import { actGuarded } from "../../ActGuarded.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";

// A click, hover, select, upload or key press. Values are substituted first, so the runtime guard
// and the driver see the final text.
export const actOnElement: StepExecutor<
    InputStep,
    StepNeeds<"values" | "cleared" | "gate" | "index" | "document">
> = async (step, context) => {
    const action = resolveInputStep(step, context.values, context.cleared.project);
    if (!action.ok) {
        return stepFailed(action.error);
    }
    const acted = await actGuarded(action.value, context.index, context, (guard) =>
        context.document.act(action.value, guard),
    );
    if (!acted.ok) {
        return acted.error;
    }
    return { outcome: StepOutcome.Passed };
};
