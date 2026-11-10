// The commands that hold requests back and decide on them.
import { browserCommand, NOTHING_TO_READ } from "../BrowserCommand.ts";
import { booleanAt, fieldOf, textAt } from "../MessagePart.ts";

export const FETCH_DOMAIN = "Fetch";

export const ENABLE_REQUEST_HOLDING = browserCommand<{
    readonly patterns: readonly {
        readonly urlPattern: string;
        readonly requestStage: "Request";
        readonly resourceType?: string;
    }[];
}>()(`${FETCH_DOMAIN}.enable`, NOTHING_TO_READ);

export const FULFIL_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly responseCode: number;
    readonly responseHeaders: readonly { readonly name: string; readonly value: string }[];
    readonly body: string;
}>()(`${FETCH_DOMAIN}.fulfillRequest`, NOTHING_TO_READ);

export const FAIL_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly errorReason: "BlockedByClient" | "Aborted";
}>()(`${FETCH_DOMAIN}.failRequest`, NOTHING_TO_READ);

export const CONTINUE_REQUEST = browserCommand<{
    readonly requestId: string;
    readonly interceptResponse?: true;
}>()(`${FETCH_DOMAIN}.continueRequest`, NOTHING_TO_READ);

export const GET_RESPONSE_BODY = browserCommand<{ readonly requestId: string }>()(
    `${FETCH_DOMAIN}.getResponseBody`,
    (reply) => ({
        body: textAt(fieldOf(reply, "body")),
        base64Encoded: booleanAt(fieldOf(reply, "base64Encoded")),
    }),
);
