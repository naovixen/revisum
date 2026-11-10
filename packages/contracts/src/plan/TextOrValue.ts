// The text a plan writes: literal text that passed the engine's safety rules, or a reference to a
// run value that the run replaces with its text.
import type { Brand } from "../foundation/Brand.ts";

// Text that passed the engine's safety rules: no control or bidirectional-override characters
// and nothing that looks like script.
export type SafeText = Brand<string, "SafeText">;

// A run value's name, such as "orderCode": a lowercase letter, then letters and digits.
export type ValueName = Brand<string, "ValueName">;
export type ValueReference = { readonly valueName: ValueName };
// Literal text, or a reference to a run value that the run replaces with its text.
export type TextOrValue = SafeText | ValueReference;

// Text of several lines for a fill, joined with line feeds and inserted as text, with no Enter
// key press, so a chat box does not send early.
export type MultiLineText = { readonly lines: readonly TextOrValue[] };
