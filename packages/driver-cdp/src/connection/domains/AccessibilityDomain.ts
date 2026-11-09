// The commands that read the browser's accessibility tree.
import type { AccessibilityTreeNode } from "../RemoteObject.ts";
import { browserCommand } from "../BrowserCommand.ts";
import { accessibilityTreeNodeAt, fieldOf, listAt, type MessagePart } from "../MessagePart.ts";

export const ACCESSIBILITY_DOMAIN = "Accessibility";

const accessibilityNodesAt = (
    reply: MessagePart,
): { readonly nodes: readonly AccessibilityTreeNode[] } => ({
    nodes: listAt(fieldOf(reply, "nodes"), accessibilityTreeNodeAt),
});

export const GET_FULL_ACCESSIBILITY_TREE = browserCommand<{ readonly frameId?: string }>()(
    `${ACCESSIBILITY_DOMAIN}.getFullAXTree`,
    accessibilityNodesAt,
);

export const GET_PARTIAL_ACCESSIBILITY_TREE = browserCommand<{
    readonly objectId: string;
    readonly fetchRelatives: false;
}>()(`${ACCESSIBILITY_DOMAIN}.getPartialAXTree`, accessibilityNodesAt);

export const QUERY_ACCESSIBILITY_TREE = browserCommand<{
    readonly backendNodeId: number;
    readonly role: string;
    readonly accessibleName: string;
}>()(`${ACCESSIBILITY_DOMAIN}.queryAXTree`, accessibilityNodesAt);
