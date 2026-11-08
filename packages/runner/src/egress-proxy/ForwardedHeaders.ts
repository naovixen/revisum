import type { IncomingHttpHeaders } from "node:http";
import { EGRESS_DECISION_HEADER } from "./EgressDecisionHeader.ts";

// Headers that describe one connection, not the request, so they are never forwarded.
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

const headersWithout = (
    headers: IncomingHttpHeaders,
    isDropped: (name: string) => boolean,
): IncomingHttpHeaders =>
    Object.fromEntries(
        Object.entries(headers).filter(([name, value]) => !isDropped(name) && value !== undefined),
    );

// The headers forwarded upstream: the client's, less the hop-by-hop ones, with the Host the URL names.
export const forwardedHeaders = (
    headers: IncomingHttpHeaders,
    host: string,
): IncomingHttpHeaders => ({
    ...headersWithout(headers, (name) => HOP_BY_HOP_HEADERS.has(name)),
    host,
    connection: "close",
});

// The headers passed back from a service: its own, less the hop-by-hop ones and the proxy's mark.
export const answerHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders =>
    headersWithout(
        headers,
        (name) => HOP_BY_HOP_HEADERS.has(name) || name === EGRESS_DECISION_HEADER,
    );
