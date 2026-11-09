// The keys the driver holds down for a press step's modifiers. ControlOrMeta stands for the
// platform's command key: Meta on macOS, Control everywhere else. The browser runs on the machine
// the driver runs on, so that machine's platform decides. Every other modifier is held as itself,
// in the order the plan writes them; a key written twice through ControlOrMeta, such as Control
// and ControlOrMeta off macOS, is held once, where it first appears.
import { Modifier } from "@revisum/contracts";

export type HeldModifierKey = "Alt" | "Control" | "Meta" | "Shift";

// The key a shortcut's Control-or-Meta is on this platform: Meta (Command) on macOS, Control elsewhere.
const controlOrMetaOn = (platform: NodeJS.Platform): HeldModifierKey =>
    platform === "darwin" ? "Meta" : "Control";

export function heldModifierKeys(
    modifiers: readonly Modifier[],
    platform: NodeJS.Platform,
): readonly HeldModifierKey[] {
    const held: HeldModifierKey[] = [];
    for (const modifier of modifiers) {
        const key: HeldModifierKey =
            modifier === Modifier.ControlOrMeta ? controlOrMetaOn(platform) : modifier;
        if (!held.includes(key)) {
            held.push(key);
        }
    }
    return held;
}
