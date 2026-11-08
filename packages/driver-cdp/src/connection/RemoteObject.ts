// The shapes of what the browser replies, once MessagePart.ts has read them: the objects a script
// gives back, the frame tree and the accessibility tree.
export type RemoteObject = {
    readonly type: string;
    readonly subtype: string | undefined;
    readonly value: unknown;
    readonly unserializableValue: string | undefined;
    readonly objectId: string | undefined;
};
export type CallResult = {
    readonly result: RemoteObject;
    readonly exceptionDetails:
        | {
              readonly text: string;
              readonly exception:
                  (RemoteObject & { readonly description: string | undefined }) | undefined;
          }
        | undefined;
};
export type ListedProperty = {
    readonly name: string;
    readonly value: { readonly objectId: string | undefined } | undefined;
};
export type FrameTree = {
    readonly frame: {
        readonly id: string;
        readonly url: string;
        readonly securityOrigin: string | undefined;
        readonly unreachableUrl: string | undefined;
    };
    readonly childFrames: readonly FrameTree[] | undefined;
};
export type AccessibilityTreeNode = {
    readonly nodeId: string;
    readonly ignored: boolean;
    readonly role: string | undefined;
    readonly name: string | undefined;
    readonly childIds: readonly string[] | undefined;
    readonly parentId: string | undefined;
    readonly backendDOMNodeId: number | undefined;
    readonly properties: readonly AccessibilityProperty[] | undefined;
};
export type AccessibilityProperty = { readonly name: string; readonly value: unknown };
