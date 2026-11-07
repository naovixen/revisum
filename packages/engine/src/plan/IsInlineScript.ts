// The one rule for which form a page script step's `script` takes as the parser meets it: any object
// is the inline form, whatever it holds, and anything else names a declared script. The parser's
// feature check and its reader both ask this, so an empty or broken inline script is refused as an
// inline script, never as a named one. What reads a parsed plan asks isInlineChoice.
import { isNonArrayObject } from "@revisum/contracts";

export const isInlineScript = (script: unknown): script is Readonly<Record<string, unknown>> =>
    isNonArrayObject(script);
