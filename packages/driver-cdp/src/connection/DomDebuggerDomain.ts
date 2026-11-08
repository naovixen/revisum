// The command that lists an element's event listeners.
import { browserCommand } from "./BrowserCommand.ts";
import { fieldOf, listAt, textAt } from "./MessagePart.ts";

export const DOM_DEBUGGER_DOMAIN = "DOMDebugger";

export const GET_EVENT_LISTENERS = browserCommand<{ readonly objectId: string }>()(
    `${DOM_DEBUGGER_DOMAIN}.getEventListeners`,
    (reply) => ({
        listeners: listAt(fieldOf(reply, "listeners"), (listener) => ({
            type: textAt(fieldOf(listener, "type")),
        })),
    }),
);
