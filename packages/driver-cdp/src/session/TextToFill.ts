// What a fill types. This is the one module of the driver that reveals a secret, at the moment it
// is typed.
import { FillValueKind, reveal, type PerformableFill } from "@revisum/contracts";
import type { HasStepEnded, PageInput } from "../page/PageOperations.ts";

// What a fill puts into its element.
export type TextToFill = PerformableFill["value"];

// True when a fill types a secret, which is revealed only as it is typed.
export function isSecretFill(fill: PerformableFill): boolean {
    switch (fill.value.kind) {
        case FillValueKind.Secret:
            return true;
        case FillValueKind.Text:
        case FillValueKind.Lines:
            return false;
    }
}

// Types a fill's value into the element. The secret is revealed here, in the call that types it, and
// nowhere else in this driver; no text comes back. Lines are joined by line feeds and inserted as
// text, so no Enter key press can send a form early.
export function typeFill<Handle>(
    input: Pick<PageInput<Handle>, "fill">,
    element: Handle,
    value: TextToFill,
    hasStepEnded: HasStepEnded,
): Promise<void> {
    switch (value.kind) {
        case FillValueKind.Text:
            return input.fill(element, value.text, hasStepEnded);
        case FillValueKind.Lines:
            return input.fill(element, value.lines.join("\n"), hasStepEnded);
        case FillValueKind.Secret:
            return input.fill(element, reveal(value.secret), hasStepEnded);
    }
}
