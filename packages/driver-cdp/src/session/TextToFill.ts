// What a fill types. This is the one module of the driver that reveals a secret, at the moment it
// is typed.
import { FillValueKind, reveal, type PerformableFill } from "@revisum/contracts";

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

// The text a fill types. The secret is revealed here, as it is typed, and nowhere else in this driver.
// Lines are joined by line feeds and inserted as text, so no Enter key press can send a form early.
export function textToFill(value: PerformableFill["value"]): string {
    switch (value.kind) {
        case FillValueKind.Text:
            return value.text;
        case FillValueKind.Lines:
            return value.lines.join("\n");
        case FillValueKind.Secret:
            return reveal(value.secret);
    }
}
