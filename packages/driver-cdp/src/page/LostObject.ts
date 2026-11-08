// How the browser says what a command was about has gone. Each is the browser's own text.
import { errorText } from "../connection/ErrorText.ts";
import { DocumentGone } from "./DocumentGone.ts";

// Messages of a command about an object whose document was replaced, or whose tab has closed.
export const LOST_OBJECT =
    /Cannot find context|Could not find object|Execution context was destroyed|Inspected target navigated or closed|Session with given id not found/i;

// How making a script world fails for a frame the page has removed.
export const FRAME_REMOVED = /No frame for given id found/;

// True when a command to make a script world failed because the frame has gone from this page's
// renderer: removed, or now running its document in another renderer process, which the browser
// answers the same way.
export const isFrameOutOfReach = (error: unknown): boolean => FRAME_REMOVED.test(errorText(error));

// True when a command failed because its object has gone with its document or tab.
export const isLostObject = (error: unknown): boolean => LOST_OBJECT.test(errorText(error));

// How a command fails once its session has closed the connection, which took every document with it.
const CONNECTION_CLOSED = /connection closed/;

// True when a command failed because its document has gone: its objects, its frame, or the whole session.
export const isDocumentGone = (error: unknown): boolean =>
    error instanceof DocumentGone ||
    isLostObject(error) ||
    FRAME_REMOVED.test(errorText(error)) ||
    CONNECTION_CLOSED.test(errorText(error));
