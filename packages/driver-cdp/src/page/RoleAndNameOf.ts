// What the browser's accessibility engine says of an element or a document, as assistive technology
// reads it.
import type { A11yNode } from "@revisum/contracts";
import {
    GET_FULL_ACCESSIBILITY_TREE,
    GET_PARTIAL_ACCESSIBILITY_TREE,
} from "../connection/CallFunctionOn.ts";
import type { AccessibilityTreeNode } from "../connection/RemoteObject.ts";
import type { PageCommands } from "./PageCommands.ts";
import type { ExposedStates, RoleAndName } from "./PageOperations.ts";

// Chromium-internal roles mapped to ARIA roles, and structural roles left out of snapshots.
const ROLE_NAMES: Readonly<Record<string, string>> = {
    RootWebArea: "document",
    image: "img",
    LabelText: "label",
};
const TRANSPARENT_ROLES = new Set([
    "none",
    "generic",
    "StaticText",
    "InlineTextBox",
    "LineBreak",
    "ignored",
    "presentation",
]);

// The accessibility properties that hold an element's selected, expanded and pressed states.
type ExposedStateProperty = "selected" | "expanded" | "pressed";

// A state property's value: a boolean, or a tristate text. "mixed" (partly pressed) counts as on.
function stateValue(value: unknown): boolean | null {
    if (value === true || value === "true" || value === "mixed") {
        return true;
    }
    if (value === false || value === "false") {
        return false;
    }
    return null;
}

const textOrNull = (text: string | undefined): string | null =>
    text === undefined || text === "" ? null : text;

export async function roleAndNameOf(commands: PageCommands, element: string): Promise<RoleAndName> {
    const { nodes } = await commands.ask(GET_PARTIAL_ACCESSIBILITY_TREE, {
        objectId: element,
        fetchRelatives: false,
    });
    const node = nodes[0];
    if (node === undefined || node.ignored) {
        return { role: null, name: null };
    }
    const role = textOrNull(node.role);
    return { role: role === null ? null : (ROLE_NAMES[role] ?? role), name: textOrNull(node.name) };
}

export async function exposedStatesOf(
    commands: PageCommands,
    element: string,
): Promise<ExposedStates> {
    const { nodes } = await commands.ask(GET_PARTIAL_ACCESSIBILITY_TREE, {
        objectId: element,
        fetchRelatives: false,
    });
    const properties = nodes[0]?.properties ?? [];
    const read = (name: ExposedStateProperty): boolean | null => {
        const property = properties.find((candidate) => candidate.name === name);
        return property === undefined ? null : stateValue(property.value);
    };
    return { selected: read("selected"), expanded: read("expanded"), pressed: read("pressed") };
}

// The tree of the document, or of the frame's document when a frame is given.
export async function accessibilityTreeOf(
    commands: PageCommands,
    frameId: string | undefined,
): Promise<A11yNode> {
    const { nodes } = await commands.ask(
        GET_FULL_ACCESSIBILITY_TREE,
        frameId === undefined ? {} : { frameId },
    );
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const build = (node: AccessibilityTreeNode): A11yNode[] => {
        const children = (node.childIds ?? []).flatMap((id) => {
            const child = byId.get(id);
            return child === undefined ? [] : build(child);
        });
        const role = node.role ?? "none";
        if (node.ignored || TRANSPARENT_ROLES.has(role)) {
            return children;
        }
        return [{ role: ROLE_NAMES[role] ?? role, name: node.name ?? "", children }];
    };
    const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
    const tree = root === undefined ? [] : build(root);
    return tree.length === 1 && tree[0] !== undefined
        ? tree[0]
        : { role: "document", name: "", children: tree };
}
