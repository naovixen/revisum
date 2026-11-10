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

const CONTENT_LENGTH_HEADER = "content-length";

// The headers named in Connection, which also describe only this connection. A body's length is the
// one that can't be given up: without it, a body would reach the next hop with no framing at all.
const headersNamedInConnection = (headers: IncomingHttpHeaders): ReadonlySet<string> =>
    new Set(
        (headers.connection ?? "")
            .split(",")
            .map((name) => name.trim().toLowerCase())
            .filter((name) => name !== "" && name !== CONTENT_LENGTH_HEADER),
    );

const headersWithout = (
    headers: IncomingHttpHeaders,
    isDropped: (name: string) => boolean,
): IncomingHttpHeaders =>
    Object.fromEntries(
        Object.entries(headers).filter(([name, value]) => !isDropped(name) && value !== undefined),
    );

const endToEndHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const named = headersNamedInConnection(headers);
    return headersWithout(headers, (name) => HOP_BY_HOP_HEADERS.has(name) || named.has(name));
};

// Node adds no framing by itself to a GET, DELETE or OPTIONS, so a chunked body on one would reach
// the service bare and be read as the next request on the connection.
const bodyFraming = (headers: IncomingHttpHeaders): IncomingHttpHeaders =>
    headers["transfer-encoding"] === undefined ? {} : { "transfer-encoding": "chunked" };

// The headers forwarded upstream: the client's, less the hop-by-hop ones, with the Host the URL names
// and the body's framing kept.
export const forwardedHeaders = (
    headers: IncomingHttpHeaders,
    host: string,
): IncomingHttpHeaders => ({
    ...endToEndHeaders(headers),
    ...bodyFraming(headers),
    host,
    connection: "close",
});

// The headers passed back from a service: its own, less the hop-by-hop ones and the proxy's mark.
export const answerHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders =>
    headersWithout(endToEndHeaders(headers), (name) => name === EGRESS_DECISION_HEADER);
