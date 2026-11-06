// The policy gate's runtime guard as a step's driver call is handed it, and the denials it keeps.
import {
    PolicyVerdictKind,
    type ActionGuard,
    type GuardVerdict,
    type ResolvedElement,
    type Step,
} from "@revisum/contracts";
import type { RunContext } from "./RunContext.ts";

// What the runtime guard is given for a step that acts on no element.
export const NO_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};

// Keeps the runtime guard's denial, so the run can end Denied naming the rule, and marked
// unrecorded when the audit sink did not record it.
export function keepDenial(
    verdict: Extract<GuardVerdict, { kind: typeof PolicyVerdictKind.Deny }>,
    context: RunContext,
): void {
    context.denials.push({
        rule: verdict.rule,
        stepIndex: verdict.stepIndex,
        ...(verdict.unrecorded === true ? { unrecorded: true } : {}),
    });
}

// Asks the runtime guard about one action now, keeping its denial. True when it was allowed.
export function isAllowedNow(step: Step, index: number, context: RunContext): boolean {
    const verdict = context.gate.guardAction(
        step,
        index,
        NO_ELEMENT,
        null,
        context.cleared.target.locale,
    );
    if (verdict.kind === PolicyVerdictKind.Deny) {
        keepDenial(verdict, context);
        return false;
    }
    return true;
}

// The runtime guard the driver asks before the step's input event, with the element it resolved
// and, for a dialog step, the open dialog's text.
export function guardFor(step: Step, index: number, context: RunContext): ActionGuard {
    return (element, dialogText) => {
        const verdict = context.gate.guardAction(
            step,
            index,
            element,
            dialogText,
            context.cleared.target.locale,
        );
        if (verdict.kind === PolicyVerdictKind.Deny) {
            keepDenial(verdict, context);
        }
        return verdict;
    };
}
