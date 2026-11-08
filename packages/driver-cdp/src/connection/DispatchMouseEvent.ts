// The commands that send a page input and decide on its requests, and those of its storage.
import { browserCommand, NOTHING_TO_READ } from "./BrowserCommand.ts";
import { booleanAt, fieldOf, listAt, textAt } from "./MessagePart.ts";

// ---- Input ----

export const DISPATCH_MOUSE_EVENT = browserCommand<{
    readonly type: "mouseMoved" | "mousePressed" | "mouseReleased";
    readonly x: number;
    readonly y: number;
    readonly button?: "left";
    readonly clickCount?: number;
}>()("Input.dispatchMouseEvent", NOTHING_TO_READ);

export const DISPATCH_KEY_EVENT = browserCommand<{
    readonly type: "rawKeyDown" | "keyDown" | "keyUp";
    readonly key: string;
    readonly code: string;
    readonly windowsVirtualKeyCode: number;
    readonly nativeVirtualKeyCode?: number;
    readonly modifiers: number;
    readonly location?: number;
    readonly text?: string;
}>()("Input.dispatchKeyEvent", NOTHING_TO_READ);

export const INSERT_TEXT = browserCommand<{ readonly text: string }>()(
    "Input.insertText",
    NOTHING_TO_READ,
);

// ---- Requests ----

export const ENABLE_REQUEST_HOLDING = browserCommand<{
    readonly patterns: readonly {
        readonly urlPattern: string;
        readonly requestStage: "Request";
        readonly resourceType?: string;
    }[];
}>()("Fetch.enable", NOTHING_TO_READ);

export const FULFIL_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly responseCode: number;
    readonly responseHeaders: readonly { readonly name: string; readonly value: string }[];
    readonly body: string;
}>()("Fetch.fulfillRequest", NOTHING_TO_READ);

export const FAIL_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly errorReason: "BlockedByClient" | "Aborted";
}>()("Fetch.failRequest", NOTHING_TO_READ);

export const CONTINUE_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly interceptResponse?: true;
}>()("Fetch.continueRequest", NOTHING_TO_READ);

export const GET_RESPONSE_BODY = browserCommand<{ readonly requestId: string }>()(
    "Fetch.getResponseBody",
    (reply) => ({
        body: textAt(fieldOf(reply, "body")),
        base64Encoded: booleanAt(fieldOf(reply, "base64Encoded")),
    }),
);

export const SET_BYPASS_SERVICE_WORKER = browserCommand<{ readonly bypass: boolean }>()(
    "Network.setBypassServiceWorker",
    NOTHING_TO_READ,
);

// ---- Storage ----

type StorageId = { readonly securityOrigin: string; readonly isLocalStorage: boolean };

export const SET_STORAGE_ITEM = browserCommand<{
    readonly storageId: StorageId;
    readonly key: string;
    readonly value: string;
}>()("DOMStorage.setDOMStorageItem", NOTHING_TO_READ);

export const REMOVE_STORAGE_ITEM = browserCommand<{
    readonly storageId: StorageId;
    readonly key: string;
}>()("DOMStorage.removeDOMStorageItem", NOTHING_TO_READ);

export const GET_STORAGE_ITEMS = browserCommand<{ readonly storageId: StorageId }>()(
    "DOMStorage.getDOMStorageItems",
    (reply) => ({
        entries: listAt(fieldOf(reply, "entries"), (entry) => listAt(entry, textAt)),
    }),
);
