// The commands that read a page's document and give files to its inputs.
import { browserCommand, NOTHING_TO_READ } from "./BrowserCommand.ts";
import { fieldOf, handleAt, listAt, numberAt, optional, textAt } from "./MessagePart.ts";

export const DOM_DOMAIN = "DOM";

export const GET_DOCUMENT = browserCommand<{ readonly depth: 0 }>()(
    `${DOM_DOMAIN}.getDocument`,
    (reply) => ({
        root: { backendNodeId: numberAt(fieldOf(fieldOf(reply, "root"), "backendNodeId")) },
    }),
);

export const DESCRIBE_NODE = browserCommand<
    | { readonly objectId: string }
    | { readonly backendNodeId: number; readonly depth: 1; readonly pierce: true }
>()(`${DOM_DOMAIN}.describeNode`, (reply) => {
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
}>()(`${DOM_DOMAIN}.resolveNode`, (reply) => ({
    object: { objectId: handleAt(fieldOf(fieldOf(reply, "object"), "objectId")) },
}));

export const GET_FRAME_OWNER = browserCommand<{ readonly frameId: string }>()(
    `${DOM_DOMAIN}.getFrameOwner`,
    (reply) => ({ backendNodeId: numberAt(fieldOf(reply, "backendNodeId")) }),
);

export const SET_FILE_INPUT_FILES = browserCommand<{
    readonly files: readonly string[];
    readonly objectId: string;
}>()(`${DOM_DOMAIN}.setFileInputFiles`, NOTHING_TO_READ);

export const PUSH_NODES_BY_BACKEND_IDS = browserCommand<{
    readonly backendNodeIds: readonly number[];
}>()(`${DOM_DOMAIN}.pushNodesByBackendIdsToFrontend`, (reply) => ({
    nodeIds: listAt(fieldOf(reply, "nodeIds"), numberAt),
}));
