// How the browser says what a command was about has gone. Each is the browser's own text.
import { errorText } from "../connection/ErrorText.ts";

// Messages of a command about an object whose document was replaced, or whose tab has closed.
export const LOST_OBJECT =
    /Cannot find context|Could not find object|Execution context was destroyed|Inspected target navigated or closed|Session with given id not found/i;

// How making a script world fails for a frame the page has removed.
export const FRAME_REMOVED = /No frame for given id found/;

// True when a command failed because its object has gone with its document or tab.
export const isLostObject = (error: unknown): boolean => LOST_OBJECT.test(errorText(error));

// True when a command failed because its document has gone: its objects, or its frame.
export const isDocumentGone = (error: unknown): boolean =>
    isLostObject(error) || FRAME_REMOVED.test(errorText(error));
