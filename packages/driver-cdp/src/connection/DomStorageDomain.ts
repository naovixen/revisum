// The commands of a page's local and session storage.
import { browserCommand, NOTHING_TO_READ } from "./BrowserCommand.ts";
import { fieldOf, listAt, textAt } from "./MessagePart.ts";

export const DOM_STORAGE_DOMAIN = "DOMStorage";

type StorageId = { readonly securityOrigin: string; readonly isLocalStorage: boolean };

export const SET_STORAGE_ITEM = browserCommand<{
    readonly storageId: StorageId;
    readonly key: string;
    readonly value: string;
}>()(`${DOM_STORAGE_DOMAIN}.setDOMStorageItem`, NOTHING_TO_READ);

export const REMOVE_STORAGE_ITEM = browserCommand<{
    readonly storageId: StorageId;
    readonly key: string;
}>()(`${DOM_STORAGE_DOMAIN}.removeDOMStorageItem`, NOTHING_TO_READ);

export const GET_STORAGE_ITEMS = browserCommand<{ readonly storageId: StorageId }>()(
    `${DOM_STORAGE_DOMAIN}.getDOMStorageItems`,
    (reply) => ({
        entries: listAt(fieldOf(reply, "entries"), (entry) => listAt(entry, textAt)),
    }),
);
