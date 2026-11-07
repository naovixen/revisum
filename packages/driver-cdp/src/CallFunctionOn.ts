// The commands that run scripts in a page and read its document and its accessibility tree.
import type { AccessibilityTreeNode } from "./RemoteObject.ts";
import {
    browserCommand,
    NOTHING_TO_READ,
    type NoParameters,
    type CallArgument,
} from "./BrowserCommand.ts";
import {
    fieldOf,
    handleAt,
    listAt,
    numberAt,
    optional,
    textAt,
    callResultAt,
    listedPropertyAt,
    accessibilityTreeNodeAt,
    type MessagePart,
} from "./MessagePart.ts";

// ---- Scripts ----

export const EVALUATE = browserCommand<{
    readonly expression: string;
    readonly contextId?: number;
    readonly objectGroup?: string;
    readonly returnByValue?: boolean;
    readonly awaitPromise?: boolean;
}>()("Runtime.evaluate", callResultAt);

export const CALL_FUNCTION_ON = browserCommand<
    {
        readonly functionDeclaration: string;
        readonly arguments?: readonly CallArgument[];
        readonly awaitPromise?: boolean;
        readonly returnByValue?: boolean;
        readonly objectGroup?: string;
    } & ({ readonly objectId: string } | { readonly executionContextId: number })
>()("Runtime.callFunctionOn", callResultAt);

export const GET_PROPERTIES = browserCommand<{
    readonly objectId: string;
    readonly ownProperties: true;
}>()("Runtime.getProperties", (reply) => ({
    result: listAt(fieldOf(reply, "result"), listedPropertyAt),
}));

export const RELEASE_OBJECT = browserCommand<{ readonly objectId: string }>()(
    "Runtime.releaseObject",
    NOTHING_TO_READ,
);

export const RELEASE_OBJECT_GROUP = browserCommand<{ readonly objectGroup: string }>()(
    "Runtime.releaseObjectGroup",
    NOTHING_TO_READ,
);

export const RUN_IF_WAITING_FOR_DEBUGGER = browserCommand<NoParameters>()(
    "Runtime.runIfWaitingForDebugger",
    NOTHING_TO_READ,
);

// ---- The document ----

export const GET_DOCUMENT = browserCommand<{ readonly depth: 0 }>()("DOM.getDocument", (reply) => ({
    root: { backendNodeId: numberAt(fieldOf(fieldOf(reply, "root"), "backendNodeId")) },
}));

export const DESCRIBE_NODE = browserCommand<
    | { readonly objectId: string }
    | { readonly backendNodeId: number; readonly depth: 1; readonly pierce: true }
>()("DOM.describeNode", (reply) => {
    const node = fieldOf(reply, "node");
    return {
        node: {
            backendNodeId: numberAt(fieldOf(node, "backendNodeId")),
            frameId: optional(fieldOf(node, "frameId"), textAt),
            contentDocument: optional(fieldOf(node, "contentDocument"), (document) => ({
                backendNodeId: numberAt(fieldOf(document, "backendNodeId")),
            })),
        },
    };
});

// The browser resolves a node into an object it holds, so a reply with no handle is no answer.
export const RESOLVE_NODE = browserCommand<{
    readonly backendNodeId: number;
    readonly executionContextId?: number;
    readonly objectGroup?: string;
}>()("DOM.resolveNode", (reply) => ({
    object: { objectId: handleAt(fieldOf(fieldOf(reply, "object"), "objectId")) },
}));

export const GET_FRAME_OWNER = browserCommand<{ readonly frameId: string }>()(
    "DOM.getFrameOwner",
    (reply) => ({ backendNodeId: numberAt(fieldOf(reply, "backendNodeId")) }),
);

export const SET_FILE_INPUT_FILES = browserCommand<{
    readonly files: readonly string[];
    readonly objectId: string;
}>()("DOM.setFileInputFiles", NOTHING_TO_READ);

export const PUSH_NODES_BY_BACKEND_IDS = browserCommand<{
    readonly backendNodeIds: readonly number[];
}>()("DOM.pushNodesByBackendIdsToFrontend", (reply) => ({
    nodeIds: listAt(fieldOf(reply, "nodeIds"), numberAt),
}));

export const GET_EVENT_LISTENERS = browserCommand<{ readonly objectId: string }>()(
    "DOMDebugger.getEventListeners",
    (reply) => ({
        listeners: listAt(fieldOf(reply, "listeners"), (listener) => ({
            type: textAt(fieldOf(listener, "type")),
        })),
    }),
);

const declarationsAt = (style: MessagePart): readonly { name: string; value: string }[] =>
    listAt(fieldOf(style, "cssProperties"), (declaration) => ({
        name: textAt(fieldOf(declaration, "name")),
        value: textAt(fieldOf(declaration, "value")),
    }));

export const GET_MATCHED_STYLES = browserCommand<{ readonly nodeId: number }>()(
    "CSS.getMatchedStylesForNode",
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

// ---- A snapshot of the page, for the accessibility engine ----

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
}>()("DOMSnapshot.captureSnapshot", (reply) => ({
    documents: listAt(fieldOf(reply, "documents"), documentSnapshotAt),
    strings: listAt(fieldOf(reply, "strings"), textAt),
}));

// ---- The accessibility engine ----

const accessibilityNodesAt = (
    reply: MessagePart,
): { readonly nodes: readonly AccessibilityTreeNode[] } => ({
    nodes: listAt(fieldOf(reply, "nodes"), accessibilityTreeNodeAt),
});

export const GET_FULL_ACCESSIBILITY_TREE = browserCommand<{ readonly frameId?: string }>()(
    "Accessibility.getFullAXTree",
    accessibilityNodesAt,
);

export const GET_PARTIAL_ACCESSIBILITY_TREE = browserCommand<{
    readonly objectId: string;
    readonly fetchRelatives: false;
}>()("Accessibility.getPartialAXTree", accessibilityNodesAt);

export const QUERY_ACCESSIBILITY_TREE = browserCommand<{
    readonly backendNodeId: number;
    readonly role: string;
    readonly accessibleName: string;
}>()("Accessibility.queryAXTree", accessibilityNodesAt);
