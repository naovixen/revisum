// What the browser sends is input from outside the program. These read one part of it at a time, each
// knowing where in the message it is, so what fails says where, and never what was there: that is page
// data, and may hold secrets.
import { MalformedBrowserReply } from "./MalformedBrowserReply.ts";
import type {
    AccessibilityProperty,
    AccessibilityTreeNode,
    ListedProperty,
    CallResult,
    FrameTree,
    RemoteObject,
} from "./RemoteObject.ts";

// One value of what the browser sent, and where in the message it is.
export type MessagePart = {
    readonly value: unknown;
    readonly method: string;
    readonly path: string;
};
type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const malformedAt = (part: MessagePart): MalformedBrowserReply =>
    new MalformedBrowserReply(part.method, part.path);

export function fieldOf(part: MessagePart, name: string): MessagePart {
    if (!isFields(part.value)) {
        throw malformedAt(part);
    }
    return { ...part, value: part.value[name], path: `${part.path}.${name}` };
}

export function textAt(part: MessagePart): string {
    if (typeof part.value !== "string") {
        throw malformedAt(part);
    }
    return part.value;
}

// A handle goes back to the browser in later commands, so nothing else may pass for one.
export function handleAt(part: MessagePart): string {
    const handle = textAt(part);
    if (handle === "") {
        throw malformedAt(part);
    }
    return handle;
}

export function numberAt(part: MessagePart): number {
    if (typeof part.value !== "number") {
        throw malformedAt(part);
    }
    return part.value;
}

export function booleanAt(part: MessagePart): boolean {
    if (typeof part.value !== "boolean") {
        throw malformedAt(part);
    }
    return part.value;
}

export function listAt<Item>(
    part: MessagePart,
    readItem: (item: MessagePart) => Item,
): readonly Item[] {
    if (!Array.isArray(part.value)) {
        throw malformedAt(part);
    }
    const items: readonly unknown[] = part.value;
    return items.map((value, index) =>
        readItem({ ...part, value, path: `${part.path}[${index}]` }),
    );
}

// JSON has no undefined, so this is a field the message left out. A null is a value of the wrong shape.
export const optional = <Value>(
    part: MessagePart,
    read: (present: MessagePart) => Value,
): Value | undefined => (part.value === undefined ? undefined : read(part));

export const remoteObjectAt = (part: MessagePart): RemoteObject => ({
    type: textAt(fieldOf(part, "type")),
    subtype: optional(fieldOf(part, "subtype"), textAt),
    value: fieldOf(part, "value").value,
    unserializableValue: optional(fieldOf(part, "unserializableValue"), textAt),
    objectId: optional(fieldOf(part, "objectId"), handleAt),
});

export const callResultAt = (reply: MessagePart): CallResult => ({
    result: remoteObjectAt(fieldOf(reply, "result")),
    exceptionDetails: optional(fieldOf(reply, "exceptionDetails"), (details) => ({
        text: textAt(fieldOf(details, "text")),
        exception: optional(fieldOf(details, "exception"), (exception) => ({
            ...remoteObjectAt(exception),
            description: optional(fieldOf(exception, "description"), textAt),
        })),
    })),
});

export const listedPropertyAt = (part: MessagePart): ListedProperty => ({
    name: textAt(fieldOf(part, "name")),
    value: optional(fieldOf(part, "value"), (value) => ({
        objectId: optional(fieldOf(value, "objectId"), handleAt),
    })),
});

const accessibleTextAt = (part: MessagePart): string | undefined =>
    optional(fieldOf(part, "value"), textAt);

const accessibilityPropertyAt = (part: MessagePart): AccessibilityProperty => ({
    name: textAt(fieldOf(part, "name")),
    value: fieldOf(fieldOf(part, "value"), "value").value,
});

export const accessibilityTreeNodeAt = (part: MessagePart): AccessibilityTreeNode => ({
    nodeId: textAt(fieldOf(part, "nodeId")),
    ignored: booleanAt(fieldOf(part, "ignored")),
    role: optional(fieldOf(part, "role"), accessibleTextAt),
    name: optional(fieldOf(part, "name"), accessibleTextAt),
    childIds: optional(fieldOf(part, "childIds"), (ids) => listAt(ids, textAt)),
    parentId: optional(fieldOf(part, "parentId"), textAt),
    backendDOMNodeId: optional(fieldOf(part, "backendDOMNodeId"), numberAt),
    properties: optional(fieldOf(part, "properties"), (properties) =>
        listAt(properties, accessibilityPropertyAt),
    ),
});

export const frameTreeAt = (part: MessagePart): FrameTree => {
    const frame = fieldOf(part, "frame");
    return {
        frame: {
            id: textAt(fieldOf(frame, "id")),
            url: textAt(fieldOf(frame, "url")),
            securityOrigin: optional(fieldOf(frame, "securityOrigin"), textAt),
            unreachableUrl: optional(fieldOf(frame, "unreachableUrl"), textAt),
        },
        childFrames: optional(fieldOf(part, "childFrames"), (children) =>
            listAt(children, frameTreeAt),
        ),
    };
};
