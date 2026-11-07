// The policy gate's runtime guard as a step's driver call is handed it. A denial is the step's
// outcome, named in what the guarded call gives back.
import {
    failure,
    PolicyVerdictKind,
    success,
    type ActionGuard,
    type GuardVerdict,
    type ResolvedElement,
    type Result,
    type Step,
} from "@revisum/contracts";
import type { Denial } from "../lifecycle.ts";
import { deniedStep, type DeniedStep } from "./executors/StepExecutor.ts";
import type { RunContext } from "./RunContext.ts";

// What the runtime guard is given for a step that acts on no element.
export const NO_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};

// What the guard asks the gate with.
type GuardContext = Pick<RunContext, "gate" | "cleared">;

// The denial the run ends Denied with, naming the rule, and marked unrecorded when the audit sink
// did not record it.
const denialOf = (
    verdict: Extract<GuardVerdict, { kind: typeof PolicyVerdictKind.Deny }>,
): Denial => ({
    rule: verdict.rule,
    stepIndex: verdict.stepIndex,
    ...(verdict.unrecorded === true ? { unrecorded: true } : {}),
});

// Asks the runtime guard about one action now: its denial, or undefined when it was allowed.
export function denialNow(step: Step, index: number, context: GuardContext): Denial | undefined {
    const verdict = context.gate.guardAction(
        step,
        index,
        NO_ELEMENT,
        null,
        context.cleared.target.locale,
    );
    return verdict.kind === PolicyVerdictKind.Deny ? denialOf(verdict) : undefined;
}

// Makes one driver call with the runtime guard the driver asks before the step's input event, with
// the element it resolved and, for a dialog step, the open dialog's text. The guard's first denial is
// the outcome, whatever the driver then answered or threw.
export async function actGuarded<Acted>(
    step: Step,
    index: number,
    context: GuardContext,
    act: (guard: ActionGuard) => Promise<Acted>,
): Promise<Result<Acted, DeniedStep>> {
    const verdicts: { denial?: Denial } = {};
    const guard: ActionGuard = (element, dialogText) => {
        const verdict = context.gate.guardAction(
            step,
            index,
            element,
            dialogText,
            context.cleared.target.locale,
        );
        if (verdict.kind === PolicyVerdictKind.Deny) {
            verdicts.denial ??= denialOf(verdict);
        }
        return verdict;
    };
    try {
        const acted = await act(guard);
        return verdicts.denial === undefined
            ? success(acted)
            : failure(deniedStep(verdicts.denial));
    } catch (error) {
        if (verdicts.denial === undefined) {
            throw error;
        }
        return failure(deniedStep(verdicts.denial));
    }
}
