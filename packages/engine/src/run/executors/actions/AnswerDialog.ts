import {
    stepFailed,
    StepOutcome,
    success,
    type DialogStep,
    type ResolvedDialogStep,
    type Result,
    type StepCode,
} from "@revisum/contracts";
import { resolveText } from "../../../run-values.ts";
import { actGuarded } from "../../ActGuarded.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";

// A dialog step with its expected text's value references replaced, as a driver must receive it.
function resolveDialogStep(
    step: DialogStep,
    context: Pick<RunContext, "values" | "cleared">,
): Result<ResolvedDialogStep, StepCode> {
    if (step.expectText === undefined) {
        return success({ type: step.type, action: step.action });
    }
    const expected = resolveText(
        step.expectText,
        context.values,
        context.cleared.project.limits.maximumTextLength,
    );
    return expected.ok
        ? success({ type: step.type, action: step.action, expectText: expected.value })
        : expected;
}

// The driver answers the dialog the page opened, asking the runtime guard first with the dialog's
// text, so accepting an irreversible one ends the run Denied with nothing sent.
export const answerDialog: StepExecutor<
    DialogStep,
    StepNeeds<"values" | "cleared" | "gate" | "index" | "document">
> = async (step, context) => {
    const answer = resolveDialogStep(step, context);
    if (!answer.ok) {
        return stepFailed(answer.error);
    }
    const acted = await actGuarded(answer.value, context.index, context, (guard) =>
        context.document.act(answer.value, guard),
    );
    if (!acted.ok) {
        return acted.error;
    }
    return acted.value.ok ? { outcome: StepOutcome.Passed } : stepFailed(acted.value.error.code);
};
