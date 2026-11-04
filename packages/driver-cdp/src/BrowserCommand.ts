// What the browser sends is input from outside the program, so it is parsed once, here, as it enters.
// A command and the decoder of its reply travel together, so a caller holds a reply only once it has
// been parsed. Anything of another shape throws MalformedBrowserReply. Only what the driver reads is
// checked, since what the browser adds beyond that says nothing either way.
import { MalformedBrowserReply } from "./MalformedBrowserReply.ts";
import type { HeldRequest } from "./network-stubs.ts";

export type BrowserCommand<Reply> = {
    readonly method: string;
    decode(reply: unknown): Reply;
};

export type RemoteObject = {
    readonly type: string;
    readonly value: unknown;
    readonly unserializableValue: string | undefined;
    readonly objectId: string | undefined;
};
export type CallResult = {
    readonly result: RemoteObject;
    readonly exceptionDetails:
        { readonly text: string; readonly exception: RemoteObject | undefined } | undefined;
};
type ListedProperty = {
    readonly name: string;
    readonly value: { readonly objectId: string | undefined } | undefined;
};
type AccessibilityTreeNode = {
    readonly nodeId: string;
    readonly ignored: boolean;
    readonly role: string | undefined;
    readonly name: string | undefined;
    readonly childIds: readonly string[] | undefined;
    readonly parentId: string | undefined;
};
export type RequestPaused = HeldRequest & { readonly requestId: string };

// One value of what the browser sent, and where in the message it is.
type MessagePart = { readonly value: unknown; readonly method: string; readonly path: string };
type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const malformedAt = (part: MessagePart): MalformedBrowserReply =>
    new MalformedBrowserReply(part.method, part.path);

function fieldOf(part: MessagePart, name: string): MessagePart {
    if (!isFields(part.value)) {
        throw malformedAt(part);
    }
    return { ...part, value: part.value[name], path: `${part.path}.${name}` };
}

function textAt(part: MessagePart): string {
    if (typeof part.value !== "string") {
        throw malformedAt(part);
    }
    return part.value;
}

// A handle goes back to the browser in later commands, so nothing else may pass for one.
function handleAt(part: MessagePart): string {
    const handle = textAt(part);
    if (handle === "") {
        throw malformedAt(part);
    }
    return handle;
}

function numberAt(part: MessagePart): number {
    if (typeof part.value !== "number") {
        throw malformedAt(part);
    }
    return part.value;
}

function booleanAt(part: MessagePart): boolean {
    if (typeof part.value !== "boolean") {
        throw malformedAt(part);
    }
    return part.value;
}

function listAt<Item>(part: MessagePart, readItem: (item: MessagePart) => Item): readonly Item[] {
    if (!Array.isArray(part.value)) {
        throw malformedAt(part);
    }
    const items: readonly unknown[] = part.value;
    return items.map((value, index) =>
        readItem({ ...part, value, path: `${part.path}[${index}]` }),
    );
}

// JSON has no undefined, so this is a field the message left out. A null is a value of the wrong shape.
const optional = <Value>(
    part: MessagePart,
    read: (present: MessagePart) => Value,
): Value | undefined => (part.value === undefined ? undefined : read(part));

const remoteObjectAt = (part: MessagePart): RemoteObject => ({
    type: textAt(fieldOf(part, "type")),
    value: fieldOf(part, "value").value,
    unserializableValue: optional(fieldOf(part, "unserializableValue"), textAt),
    objectId: optional(fieldOf(part, "objectId"), handleAt),
});

const callResultAt = (reply: MessagePart): CallResult => ({
    result: remoteObjectAt(fieldOf(reply, "result")),
    exceptionDetails: optional(fieldOf(reply, "exceptionDetails"), (details) => ({
        text: textAt(fieldOf(details, "text")),
        exception: optional(fieldOf(details, "exception"), remoteObjectAt),
    })),
});

const listedPropertyAt = (part: MessagePart): ListedProperty => ({
    name: textAt(fieldOf(part, "name")),
    value: optional(fieldOf(part, "value"), (value) => ({
        objectId: optional(fieldOf(value, "objectId"), handleAt),
    })),
});

const accessibleTextAt = (part: MessagePart): string | undefined =>
    optional(fieldOf(part, "value"), textAt);

const accessibilityTreeNodeAt = (part: MessagePart): AccessibilityTreeNode => ({
    nodeId: textAt(fieldOf(part, "nodeId")),
    ignored: booleanAt(fieldOf(part, "ignored")),
    role: optional(fieldOf(part, "role"), accessibleTextAt),
    name: optional(fieldOf(part, "name"), accessibleTextAt),
    childIds: optional(fieldOf(part, "childIds"), (ids) => listAt(ids, textAt)),
    parentId: optional(fieldOf(part, "parentId"), textAt),
});

const browserCommand = <Reply>(
    method: string,
    readReply: (reply: MessagePart) => Reply,
): BrowserCommand<Reply> => ({
    method,
    decode: (reply) => readReply({ value: reply, method, path: "result" }),
});

export const EVALUATE = browserCommand("Runtime.evaluate", callResultAt);

export const CALL_FUNCTION_ON = browserCommand("Runtime.callFunctionOn", callResultAt);

export const GET_PROPERTIES = browserCommand("Runtime.getProperties", (reply) => ({
    result: listAt(fieldOf(reply, "result"), listedPropertyAt),
}));

// The browser resolves a node into an object it holds, so a reply with no handle is no answer.
export const RESOLVE_NODE = browserCommand("DOM.resolveNode", (reply) => ({
    object: { objectId: handleAt(fieldOf(fieldOf(reply, "object"), "objectId")) },
}));

// The driver reads no frame id here, but the browser always names the frame it sent to the address,
// and a reply with no error and no frame would otherwise read as a navigation that went on.
export const NAVIGATE = browserCommand("Page.navigate", (reply) => ({
    frameId: textAt(fieldOf(reply, "frameId")),
    errorText: optional(fieldOf(reply, "errorText"), textAt),
}));

export const GET_FULL_ACCESSIBILITY_TREE = browserCommand(
    "Accessibility.getFullAXTree",
    (reply) => ({ nodes: listAt(fieldOf(reply, "nodes"), accessibilityTreeNodeAt) }),
);

export function decodeRequestPaused(parameters: unknown): RequestPaused {
    const event = { value: parameters, method: "Fetch.requestPaused", path: "params" };
    const request = fieldOf(event, "request");
    return {
        requestId: handleAt(fieldOf(event, "requestId")),
        request: {
            url: textAt(fieldOf(request, "url")),
            method: textAt(fieldOf(request, "method")),
        },
        resourceType: optional(fieldOf(event, "resourceType"), textAt),
        networkId: optional(fieldOf(event, "networkId"), textAt),
        responseStatusCode: optional(fieldOf(event, "responseStatusCode"), numberAt),
        responseErrorReason: optional(fieldOf(event, "responseErrorReason"), textAt),
    };
}
