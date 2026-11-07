// The one rule for which form a page script step's `script` takes: any object is the inline form,
// whatever it holds, and anything else names a declared script. The parser's feature check, its
// reader and what reads a parsed plan all ask this, so an empty or broken inline script is refused
// as an inline script, never as a named one.
import { isNonArrayObject } from "@revisum/contracts";

export const isInlineScript = (script: unknown): script is Readonly<Record<string, unknown>> =>
    isNonArrayObject(script);
