// The commands that run scripts in a page and read what they give.
import {
    browserCommand,
    NOTHING_TO_READ,
    type CallArgument,
    type NoParameters,
} from "../BrowserCommand.ts";
import { callResultAt, fieldOf, listAt, listedPropertyAt } from "../MessagePart.ts";

export const RUNTIME_DOMAIN = "Runtime";

export const EVALUATE = browserCommand<{
    readonly expression: string;
    readonly contextId?: number;
    readonly objectGroup?: string;
    readonly returnByValue?: boolean;
    readonly awaitPromise?: boolean;
}>()(`${RUNTIME_DOMAIN}.evaluate`, callResultAt);

export const CALL_FUNCTION_ON = browserCommand<
    {
        readonly functionDeclaration: string;
        readonly arguments?: readonly CallArgument[];
        readonly awaitPromise?: boolean;
        readonly returnByValue?: boolean;
        readonly objectGroup?: string;
    } & ({ readonly objectId: string } | { readonly executionContextId: number })
>()(`${RUNTIME_DOMAIN}.callFunctionOn`, callResultAt);

export const GET_PROPERTIES = browserCommand<{
    readonly objectId: string;
    readonly ownProperties: true;
}>()(`${RUNTIME_DOMAIN}.getProperties`, (reply) => ({
    result: listAt(fieldOf(reply, "result"), listedPropertyAt),
}));

export const RELEASE_OBJECT = browserCommand<{ readonly objectId: string }>()(
    `${RUNTIME_DOMAIN}.releaseObject`,
    NOTHING_TO_READ,
);

export const RELEASE_OBJECT_GROUP = browserCommand<{ readonly objectGroup: string }>()(
    `${RUNTIME_DOMAIN}.releaseObjectGroup`,
    NOTHING_TO_READ,
);

export const RUN_IF_WAITING_FOR_DEBUGGER = browserCommand<NoParameters>()(
    `${RUNTIME_DOMAIN}.runIfWaitingForDebugger`,
    NOTHING_TO_READ,
);
