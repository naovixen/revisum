import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { EGRESS_DECISION_HEADER, type EgressDecisionMark } from "./EgressDecisionHeader.ts";
import { ProxyClient } from "./ProxyClient.ts";

// Above the service caller's longest call of 120 s, so the caller's own timeout decides. This limit
// only clears a connection nothing is waiting on.
const SERVICE_IDLE_LIMIT_MILLISECONDS = 130_000;
const NO_IDLE_LIMIT = 0;

export type ClientTreatment = {
    readonly client: ProxyClient;
    // How a plain request the proxy won't or can't carry through ends.
    readonly declineRequest: (
        response: ServerResponse,
        status: number,
        mark: EgressDecisionMark,
        text: string,
    ) => void;
    // How a tunnel the proxy won't or can't open ends.
    readonly declineTunnel: (client: Duplex, statusLine: string) => void;
    // How long a plain request's connection may sit with nothing moving. 0 is no limit.
    readonly idleLimitMilliseconds: number;
};

// Writes an answer of the proxy's own, marked as such.
function answerFromProxy(
    response: ServerResponse,
    status: number,
    mark: EgressDecisionMark,
    text: string,
): void {
    response
        .writeHead(status, { "content-type": "text/plain", [EGRESS_DECISION_HEADER]: mark })
        .end(text);
}

// A service reads the proxy's answer and acts on it. A browser would show it to the page as content:
// a page in a worker could read a 403, and a rendered 502 would pass for a page that loaded. A closed
// socket is a network error to a browser. A page may also hold a quiet connection open on purpose.
export const TREATMENT_OF_CLIENT = {
    [ProxyClient.Service]: {
        client: ProxyClient.Service,
        declineRequest: answerFromProxy,
        declineTunnel: (client, statusLine) => {
            client.end(`HTTP/1.1 ${statusLine}\r\n\r\n`);
        },
        idleLimitMilliseconds: SERVICE_IDLE_LIMIT_MILLISECONDS,
    },
    [ProxyClient.Browser]: {
        client: ProxyClient.Browser,
        declineRequest: (response) => {
            response.destroy();
        },
        declineTunnel: (client) => {
            client.destroy();
        },
        idleLimitMilliseconds: NO_IDLE_LIMIT,
    },
} satisfies Record<ProxyClient, ClientTreatment>;
