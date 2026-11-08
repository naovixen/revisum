import type { EventEmitter } from "node:events";

// Aborts once the client's side has closed, so the proxy stops connecting on its behalf.
export function abortedOnClose(clientSide: EventEmitter): AbortSignal {
    const controller = new AbortController();
    clientSide.once("close", () => {
        controller.abort();
    });
    return controller.signal;
}
