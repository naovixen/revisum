// Which form a parsed page script step's script takes. The parser has read it already, so a name
// is text and the inline form is the object holding `inline`. The parser's own check on raw input
// is isInlineScript.
import type { InlineScript, ScriptChoice } from "@revisum/contracts";

export const isInlineChoice = (choice: ScriptChoice): choice is { readonly inline: InlineScript } =>
    typeof choice !== "string";
