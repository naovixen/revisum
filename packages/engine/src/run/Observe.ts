// What a result may keep of what the page showed: redacted, and never a secret or a remembered value.
import { isOneElementRead, UnreadablePage, type ElementProbe } from "@revisum/contracts";
import { normalise } from "../oracle.ts";
import { SENSITIVE_PLACEHOLDER } from "../redaction.ts";
import { SECRET_PLACEHOLDER } from "../secrets/secret-values.ts";
import type { RunContext } from "./RunContext.ts";

// The longest text a result keeps of what the page or a server wrote.
const LONGEST_KEPT_TEXT = 200;

const UNREADABLE_PAGE_OBSERVATIONS = {
    [UnreadablePage.ReadFailed]: "(page unreadable)",
    [UnreadablePage.DialogOpen]: "(a dialog is open)",
    [UnreadablePage.BrowserErrorPage]: "(the browser shows its own error page)",
} as const satisfies Record<UnreadablePage, string>;

// Shown instead of a remembered value's text in what a failed check observed.
const REMEMBERED_PLACEHOLDER = "[redacted:remembered-value]";
// Shorter remembered texts, such as "3", are replaced only when they are the whole observation:
// searched for inside longer text they would blank out unrelated characters.
const SHORTEST_REMEMBERED_SEARCH = 8;

// An observation with every text a remember step read replaced, so a remembered value never
// reaches the result through a failed check.
function withoutRememberedTexts(observed: string, remembered: ReadonlySet<string>): string {
    if (remembered.has(observed)) {
        return REMEMBERED_PLACEHOLDER;
    }
    let kept = observed;
    const longestFirst = [...remembered]
        .filter((text) => text.length >= SHORTEST_REMEMBERED_SEARCH)
        .sort((left, right) => right.length - left.length);
    for (const text of longestFirst) {
        kept = kept.split(text).join(REMEMBERED_PLACEHOLDER);
    }
    return kept;
}

// What keeping an observation needs of the run.
type ObserveContext = Pick<RunContext, "isShortSecret" | "withoutSecrets" | "redactor"> & {
    readonly rememberedTexts: ReadonlySet<string>;
};

// What a failed check saw, redacted: never the text of a sensitive element, nothing read from a
// field a secret was typed into, and no text that is a whole short secret.
export function observe(
    probe: ElementProbe | null,
    context: ObserveContext,
    isFilledFromSecret: boolean,
): string {
    if (probe === null || probe.count === 0 || probe.count === "selector-invalid") {
        return "(no element)";
    }
    if (typeof probe.count === "string") {
        return UNREADABLE_PAGE_OBSERVATIONS[probe.count];
    }
    if (!isOneElementRead(probe)) {
        return `(${probe.count} elements)`;
    }
    if (probe.sensitive) {
        return SENSITIVE_PLACEHOLDER;
    }
    const asWritten = probe.value ?? probe.text;
    if (isFilledFromSecret || context.isShortSecret(asWritten)) {
        return SECRET_PLACEHOLDER;
    }
    // Secrets go while the text is as the page wrote it. Collapsing first could join what a secret
    // holds apart; personal-data patterns come after, as they read collapsed text.
    const seen = normalise(context.withoutSecrets(asWritten));
    return context.redactor
        .text(withoutRememberedTexts(seen, context.rememberedTexts))
        .slice(0, LONGEST_KEPT_TEXT);
}

// Text the server chose that a result keeps, such as a file name: redacted and capped.
export const keptText = (
    text: string,
    context: Pick<RunContext, "isShortSecret" | "redactor">,
): string =>
    context.isShortSecret(text)
        ? SECRET_PLACEHOLDER
        : context.redactor.text(text).slice(0, LONGEST_KEPT_TEXT);
