import { stepFailed, StepOutcome } from "@revisum/contracts";
import { resolveInputStep, type InputStep } from "../../../run-values.ts";
import { guardFor } from "../../GuardFor.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// A click, hover, select, upload or key press. Values are substituted first, so the runtime guard
// and the driver see the final text.
export const actOnElement: StepExecutor<InputStep> = async (step, context) => {
    const action = resolveInputStep(step, context.values, context.cleared.project);
    if (!action.ok) {
        return stepFailed(action.error);
    }
    const acted = await context.document.act(
        action.value,
        guardFor(action.value, context.index, context),
    );
    return acted.ok ? { outcome: StepOutcome.Passed } : stepFailed(acted.error.code);
};
