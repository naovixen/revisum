// The keys the driver holds down for a press step's modifiers. ControlOrMeta stands for the
// platform's command key: Meta on macOS, Control everywhere else. The browser runs on the machine
// the driver runs on, so that machine's platform decides. Every other modifier is held as itself,
// in the order the plan writes them; a key written twice through ControlOrMeta, such as Control
// and ControlOrMeta off macOS, is held once, where it first appears.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import type { Modifier } from '@revisum/contracts';

export type HeldModifierKey = 'Alt' | 'Control' | 'Meta' | 'Shift';

export function heldModifierKeys(modifiers: readonly Modifier[], platform: NodeJS.Platform): readonly HeldModifierKey[] {
  const held: HeldModifierKey[] = [];
  for (const modifier of modifiers) {
    const key: HeldModifierKey = modifier === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : modifier;
    if (!held.includes(key)) held.push(key);
  }
  return held;
}
