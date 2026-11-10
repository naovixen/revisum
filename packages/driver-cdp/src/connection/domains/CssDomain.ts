// The command that reads the style rules matching an element.
import { browserCommand } from "../BrowserCommand.ts";
import { fieldOf, listAt, optional, textAt, type MessagePart } from "../MessagePart.ts";

export const CSS_DOMAIN = "CSS";

const declarationsAt = (style: MessagePart): readonly { name: string; value: string }[] =>
    listAt(fieldOf(style, "cssProperties"), (declaration) => ({
        name: textAt(fieldOf(declaration, "name")),
        value: textAt(fieldOf(declaration, "value")),
    }));

export const GET_MATCHED_STYLES = browserCommand<{ readonly nodeId: number }>()(
    `${CSS_DOMAIN}.getMatchedStylesForNode`,
    (reply) => ({
        inlineStyle: optional(fieldOf(reply, "inlineStyle"), declarationsAt),
        matchedCSSRules: optional(fieldOf(reply, "matchedCSSRules"), (rules) =>
            listAt(rules, (matched) => {
                const rule = fieldOf(matched, "rule");
                return {
                    origin: textAt(fieldOf(rule, "origin")),
                    declarations: declarationsAt(fieldOf(rule, "style")),
                };
            }),
        ),
    }),
);
