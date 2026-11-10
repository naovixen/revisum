// The events the driver reads from the browser, each with its decoder. An event of another shape is a
// failure its listener is told, so nothing is thrown out of the socket's own handler.
import { failure, success, type Result } from "@revisum/contracts";
import { NOTHING_TO_READ } from "./BrowserCommand.ts";
import {
    booleanAt,
    fieldOf,
    handleAt,
    numberAt,
    optional,
    textAt,
    type MessagePart,
} from "./MessagePart.ts";
import { MalformedBrowserReply } from "./MalformedBrowserReply.ts";

export type BrowserEvent<Payload> = {
    readonly name: string;
    // A failure is the path of what is malformed, never what was there, which may hold page data.
    decode(parameters: unknown): Result<Payload, string>;
};

const browserEvent = <Payload>(
    name: string,
    readEvent: (event: MessagePart) => Payload,
): BrowserEvent<Payload> => ({
    name,
    decode(parameters) {
        try {
            return success(readEvent({ value: parameters, method: name, path: "params" }));
        } catch (error) {
            if (error instanceof MalformedBrowserReply) {
                return failure(error.message);
            }
            throw error;
        }
    },
});

// What the Fetch domain says of a request it holds: before it is sent, or once its response is in. A
// request's own fields say which, and a response stage has a status or the reason there is none.
type HeldRequestFields = {
    readonly requestId: string;
    readonly resourceType: string | undefined;
    readonly request: { readonly url: string; readonly method: string };
    readonly frameId: string | undefined;
    // The Network domain's id for the same request, when that domain sees it.
    readonly networkId: string | undefined;
};
export type RequestAtRequestStage = HeldRequestFields & { readonly stage: "request" };
export type RequestAtResponseStage = HeldRequestFields & {
    readonly stage: "response";
    readonly hasFailed: boolean;
};
export type RequestPaused = RequestAtRequestStage | RequestAtResponseStage;

const frameIdOf = (event: MessagePart): { readonly frameId: string } => ({
    frameId: textAt(fieldOf(event, "frameId")),
});

export const TARGET_CRASHED = browserEvent("Target.targetCrashed", (event) => ({
    targetId: textAt(fieldOf(event, "targetId")),
}));

export const DETACHED_FROM_TARGET = browserEvent("Target.detachedFromTarget", (event) => ({
    sessionId: textAt(fieldOf(event, "sessionId")),
}));

export const ATTACHED_TO_TARGET = browserEvent("Target.attachedToTarget", (event) => {
    const info = fieldOf(event, "targetInfo");
    return {
        sessionId: textAt(fieldOf(event, "sessionId")),
        waitingForDebugger: booleanAt(fieldOf(event, "waitingForDebugger")),
        targetInfo: {
            targetId: textAt(fieldOf(info, "targetId")),
            type: textAt(fieldOf(info, "type")),
            browserContextId: optional(fieldOf(info, "browserContextId"), textAt),
            openerId: optional(fieldOf(info, "openerId"), textAt),
        },
    };
});

export const DIALOG_OPENING = browserEvent("Page.javascriptDialogOpening", (event) => ({
    message: textAt(fieldOf(event, "message")),
}));

export const DIALOG_CLOSED = browserEvent("Page.javascriptDialogClosed", (event) => ({
    result: booleanAt(fieldOf(event, "result")),
}));

export const FRAME_REQUESTED_NAVIGATION = browserEvent(
    "Page.frameRequestedNavigation",
    (event) => ({
        ...frameIdOf(event),
        disposition: textAt(fieldOf(event, "disposition")),
    }),
);

export const FRAME_NAVIGATED = browserEvent("Page.frameNavigated", (event) => ({
    frameId: textAt(fieldOf(fieldOf(event, "frame"), "id")),
}));

export const NAVIGATED_WITHIN_DOCUMENT = browserEvent("Page.navigatedWithinDocument", frameIdOf);

export const FRAME_STOPPED_LOADING = browserEvent("Page.frameStoppedLoading", frameIdOf);

export const BINDING_CALLED = browserEvent("Runtime.bindingCalled", (event) => ({
    name: textAt(fieldOf(event, "name")),
    payload: textAt(fieldOf(event, "payload")),
}));

export const REQUEST_PAUSED = browserEvent("Fetch.requestPaused", (event): RequestPaused => {
    const request = fieldOf(event, "request");
    const held: HeldRequestFields = {
        requestId: handleAt(fieldOf(event, "requestId")),
        request: {
            url: textAt(fieldOf(request, "url")),
            method: textAt(fieldOf(request, "method")),
        },
        resourceType: optional(fieldOf(event, "resourceType"), textAt),
        frameId: optional(fieldOf(event, "frameId"), textAt),
        networkId: optional(fieldOf(event, "networkId"), textAt),
    };
    const status = optional(fieldOf(event, "responseStatusCode"), numberAt);
    const errorReason = optional(fieldOf(event, "responseErrorReason"), textAt);
    return status === undefined && errorReason === undefined
        ? { ...held, stage: "request" }
        : { ...held, stage: "response", hasFailed: errorReason !== undefined };
});

const responseSummaryAt = (
    response: MessagePart,
): { readonly status: number; readonly mimeType: string | undefined } => ({
    status: numberAt(fieldOf(response, "status")),
    mimeType: optional(fieldOf(response, "mimeType"), textAt),
});

export const REQUEST_WILL_BE_SENT = browserEvent("Network.requestWillBeSent", (event) => {
    const request = fieldOf(event, "request");
    return {
        requestId: textAt(fieldOf(event, "requestId")),
        request: {
            url: textAt(fieldOf(request, "url")),
            method: textAt(fieldOf(request, "method")),
        },
        type: optional(fieldOf(event, "type"), textAt),
        redirectResponse: optional(fieldOf(event, "redirectResponse"), responseSummaryAt),
    };
});

export const RESPONSE_RECEIVED = browserEvent("Network.responseReceived", (event) => ({
    requestId: textAt(fieldOf(event, "requestId")),
    response: responseSummaryAt(fieldOf(event, "response")),
}));

export const LOADING_FAILED = browserEvent("Network.loadingFailed", (event) => ({
    requestId: textAt(fieldOf(event, "requestId")),
}));

export const WEB_SOCKET_CREATED = browserEvent("Network.webSocketCreated", (event) => ({
    url: textAt(fieldOf(event, "url")),
}));

export const LOAD_EVENT_FIRED = browserEvent("Page.loadEventFired", NOTHING_TO_READ);

// The renderer of a session's page has died. The event says nothing more.
export const INSPECTOR_TARGET_CRASHED = browserEvent("Inspector.targetCrashed", NOTHING_TO_READ);

// The browser's download ids (its "guid" field). Nothing else is ever used as a file name, so an id of
// another form is a malformed event.
const DOWNLOAD_ID = /^[0-9A-Za-z-]{8,64}$/;

const downloadIdAt = (part: MessagePart): string => {
    const downloadId = textAt(part);
    if (!DOWNLOAD_ID.test(downloadId)) {
        throw new MalformedBrowserReply(part.method, part.path);
    }
    return downloadId;
};

// A download the browser has started, in the frame it began in.
export type DownloadBegun = {
    readonly downloadId: string;
    readonly frameId: string;
    readonly url: string;
    readonly suggestedFilename: string;
};

export const DOWNLOAD_WILL_BEGIN = browserEvent(
    "Browser.downloadWillBegin",
    (event): DownloadBegun => ({
        downloadId: downloadIdAt(fieldOf(event, "guid")),
        frameId: textAt(fieldOf(event, "frameId")),
        url: textAt(fieldOf(event, "url")),
        suggestedFilename: textAt(fieldOf(event, "suggestedFilename")),
    }),
);

export const DownloadState = {
    InProgress: "inProgress",
    Completed: "completed",
    Canceled: "canceled",
} as const;
export type DownloadState = (typeof DownloadState)[keyof typeof DownloadState];

const downloadStateAt = (part: MessagePart): DownloadState => {
    const state = textAt(part);
    const known = Object.values(DownloadState).find((candidate) => candidate === state);
    if (known === undefined) {
        throw new MalformedBrowserReply(part.method, part.path);
    }
    return known;
};

export const DOWNLOAD_PROGRESS = browserEvent("Browser.downloadProgress", (event) => ({
    downloadId: textAt(fieldOf(event, "guid")),
    receivedBytes: numberAt(fieldOf(event, "receivedBytes")),
    state: downloadStateAt(fieldOf(event, "state")),
}));

// What a download's media type is read from: the URL and media type of a response a page received.
export const RESPONSE_MEDIA_TYPE = browserEvent("Network.responseReceived", (event) => {
    const response = fieldOf(event, "response");
    return {
        url: textAt(fieldOf(response, "url")),
        mimeType: textAt(fieldOf(response, "mimeType")),
    };
});
