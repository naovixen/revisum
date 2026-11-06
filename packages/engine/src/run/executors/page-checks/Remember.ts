import {
    DomReadKind,
    oneElementOf,
    RememberElementRead,
    StepCode,
    stepFailed,
    StepOutcome,
    type DomRead,
    type OneElementRead,
    type RememberedElementSource,
    type StepByType,
} from "@revisum/contracts";
import { rememberFromClipboard } from "../../../clock-and-clipboard-steps.ts";
import { canonicalJson } from "../../../hashing.ts";
import { rememberFromResponse } from "../../../network-and-storage/network-and-storage-steps.ts";
import { normalise, type Verdict } from "../../../oracle.ts";
import { resolveLocator } from "../../../run-values.ts";
import { poll } from "../../Poll.ts";
import { clockAndClipboardContext } from "../clock-and-clipboard/ClockAndClipboardExecutors.ts";
import { networkContext } from "../network-and-storage/NetworkAndStorageExecutors.ts";
import type { StepContext, StepExecutor, StepRecord } from "../StepExecutor.ts";

type RememberStep = StepByType["remember"];

// What one look at the page gives: an element's check, or text that is empty, which a later look
// may fill.
type RememberVerdict =
    Verdict | { readonly pass: false; readonly code: typeof StepCode.ValueEmpty };
const EMPTY: RememberVerdict = { pass: false, code: StepCode.ValueEmpty };

// The text one element gives: its normalised text or input value, or one attribute exactly as the
// page holds it.
function textOf(element: OneElementRead, from: RememberedElementSource): string {
    if (from.read === RememberElementRead.Attribute) {
        return element.dom?.kind === DomReadKind.Attribute ? (element.dom.value ?? "") : "";
    }
    return normalise(
        from.read === RememberElementRead.Value ? (element.value ?? "") : element.text,
    );
}

// Reads a remember step's value from the page through the prober, waiting as a check waits until
// the locator matches one element with non-empty text (or input value), whitespace normalised, or
// with a non-empty attribute, taken exactly as the page holds it.
// The text must be safe text no longer than the project's maximumTextLength. Only the value's name
// and sha256 are kept in the result and the events, never the text.
async function rememberFromPage(
    step: RememberStep,
    from: RememberedElementSource,
    context: StepContext,
): Promise<StepRecord> {
    const locator = resolveLocator(from.element, context.values, context.cleared.project);
    if (!locator.ok) {
        return stepFailed(locator.error);
    }
    // A remembered value is hashed into the result and can be sent on by a later step, and a hash of
    // a short secret is as good as the secret.
    if (context.secretFilledFields.has(canonicalJson(locator.value))) {
        return stepFailed(StepCode.ValueHoldsSecret);
    }
    const read: DomRead | null =
        from.read === RememberElementRead.Attribute
            ? { kind: DomReadKind.Attribute, name: from.attribute }
            : null;
    const seen = { text: "" };
    const verdict = await poll(context, context.document, async (): Promise<RememberVerdict> => {
        const found = oneElementOf(await context.document.probe(locator.value, read));
        if (!found.ok) {
            return { pass: false, code: found.error };
        }
        seen.text = textOf(found.value, from);
        return seen.text === "" ? EMPTY : { pass: true };
    });
    // A remember step keeps no observation, so a stopped check and the check's own answer fail it alike.
    if (!verdict.pass) {
        return stepFailed(verdict.code);
    }
    const kept = context.remembered.remember(step.name, seen.text, context.index);
    return kept.ok
        ? { outcome: StepOutcome.Passed, remembered: kept.value }
        : stepFailed(kept.error);
}

// A remember step reads from the page, from the latest response a declared request check saw, or
// from the clipboard.
export const remember: StepExecutor<RememberStep> = async (step, context) => {
    if ("response" in step.from) {
        return rememberFromResponse(step, step.from, context.index, networkContext(context));
    }
    if ("clipboard" in step.from) {
        return rememberFromClipboard(step, context.index, clockAndClipboardContext(context));
    }
    return rememberFromPage(step, step.from, context);
};
