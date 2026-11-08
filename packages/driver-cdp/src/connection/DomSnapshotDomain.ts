// The command that takes a snapshot of the page for the accessibility engine.
import { browserCommand } from "./BrowserCommand.ts";
import { fieldOf, listAt, numberAt, optional, textAt, type MessagePart } from "./MessagePart.ts";

export const DOM_SNAPSHOT_DOMAIN = "DOMSnapshot";

type RareValues = { readonly index: readonly number[]; readonly value: readonly number[] };

const numbersAt = (part: MessagePart): readonly number[] => listAt(part, numberAt);
const numberListsAt = (part: MessagePart): readonly (readonly number[])[] =>
    listAt(part, numbersAt);
const rareValuesAt = (part: MessagePart): RareValues => ({
    index: numbersAt(fieldOf(part, "index")),
    value: numbersAt(fieldOf(part, "value")),
});

const documentSnapshotAt = (part: MessagePart) => {
    const nodes = fieldOf(part, "nodes");
    const layout = fieldOf(part, "layout");
    return {
        documentURL: numberAt(fieldOf(part, "documentURL")),
        nodes: {
            parentIndex: numbersAt(fieldOf(nodes, "parentIndex")),
            nodeType: numbersAt(fieldOf(nodes, "nodeType")),
            nodeName: numbersAt(fieldOf(nodes, "nodeName")),
            nodeValue: numbersAt(fieldOf(nodes, "nodeValue")),
            backendNodeId: numbersAt(fieldOf(nodes, "backendNodeId")),
            attributes: numberListsAt(fieldOf(nodes, "attributes")),
            shadowRootType: optional(fieldOf(nodes, "shadowRootType"), rareValuesAt),
            contentDocumentIndex: optional(fieldOf(nodes, "contentDocumentIndex"), rareValuesAt),
            isClickable: optional(fieldOf(nodes, "isClickable"), (clickable) => ({
                index: numbersAt(fieldOf(clickable, "index")),
            })),
            pseudoType: optional(fieldOf(nodes, "pseudoType"), rareValuesAt),
        },
        layout: {
            nodeIndex: numbersAt(fieldOf(layout, "nodeIndex")),
            styles: numberListsAt(fieldOf(layout, "styles")),
            bounds: numberListsAt(fieldOf(layout, "bounds")),
            blendedBackgroundColors: optional(
                fieldOf(layout, "blendedBackgroundColors"),
                numbersAt,
            ),
            textColorOpacities: optional(fieldOf(layout, "textColorOpacities"), numbersAt),
            scrollRects: optional(fieldOf(layout, "scrollRects"), numberListsAt),
            clientRects: optional(fieldOf(layout, "clientRects"), numberListsAt),
        },
    };
};

export const CAPTURE_SNAPSHOT = browserCommand<{
    readonly computedStyles: readonly string[];
    readonly includeDOMRects: true;
    readonly includeBlendedBackgroundColors: true;
    readonly includeTextColorOpacities: true;
}>()(`${DOM_SNAPSHOT_DOMAIN}.captureSnapshot`, (reply) => ({
    documents: listAt(fieldOf(reply, "documents"), documentSnapshotAt),
    strings: listAt(fieldOf(reply, "strings"), textAt),
}));
