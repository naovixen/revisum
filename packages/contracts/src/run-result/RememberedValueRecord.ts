import type { ValueName } from "../plan.ts";

// A remember step's record: the value's name and the sha256 of its text, never the text.
export type RememberedValueRecord = { readonly valueName: ValueName; readonly sha256: string };
