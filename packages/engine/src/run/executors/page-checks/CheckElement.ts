import { stepFailed, StepOutcome, type ElementProbe, type StepByType } from "@revisum/contracts";
import { canonicalJson } from "../../../hashing.ts";
import { checkElement as judgeElement, domReadFor } from "../../../oracle.ts";
import { resolveElementAssertion, resolveLocator } from "../../../run-values.ts";
import { observe } from "../../Observe.ts";
import { isCheckStopped, poll } from "../../Poll.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// Waits until the element the locator finds passes the check, or the step timeout runs out. A failed
// check keeps what it last saw, redacted.
export const checkElement: StepExecutor<StepByType["expect"]> = async (step, context) => {
    const locator = resolveLocator(step.locator, context.values, context.cleared.project);
    if (!locator.ok) {
        return stepFailed(locator.error);
    }
    const assertion = resolveElementAssertion(step.assert, context.values, context.cleared.project);
    if (!assertion.ok) {
        return stepFailed(assertion.error);
    }
    // A DOM check asks the probe to read the class, style or attribute it compares.
    const read = domReadFor(assertion.value);
    const seen: { last: ElementProbe | null } = { last: null };
    const verdict = await poll(context, context.document, async () => {
        seen.last = await context.document.probe(locator.value, read);
        return judgeElement(assertion.value, seen.last, context.inputs.baseUrl);
    });
    if (isCheckStopped(verdict)) {
        return stepFailed(verdict.code);
    }
    if (verdict.pass) {
        return { outcome: StepOutcome.Passed };
    }
    const isFilledFromSecret = context.secretFilledFields.has(canonicalJson(locator.value));
    return {
        ...stepFailed(verdict.code),
        observed: observe(seen.last, context, isFilledFromSecret),
    };
};
