// Runner's side of the ServiceCaller port: the one runner module that may read a secret. A declared
// call's request carries each secret header, and each secret in its JSON body, as an opaque Secret;
// it is revealed only here, as the request is written for sending, so no other code holds the text.
// A workload's declared secrets are revealed here too, as its container's environment is written
//
// serviceCaller() is the real caller. It sends every request through the egress proxy, so the
// proxy's allow-list and resolve-time address check decide where a call may go; it never connects
// to a service itself. It never follows a redirect, stops reading one byte past the request's size
// cap, leaving the engine to judge the status and refuse a body that long, and sends each request
// once: nothing here retries, so a write is never sent twice. No header value is written anywhere but
// the wire, and a failure answers with its code alone.
import {
    failure,
    reveal,
    success,
    type Result,
    type ServiceCallErrorCode,
    type ServiceCaller,
    type ServiceRequest,
    type ServiceRequestHeader,
    type ServiceResponse,
    type WorkloadVariable,
} from "@revisum/contracts";
import {
    request as sendHttpRequest,
    type ClientRequest,
    type IncomingMessage,
    type OutgoingHttpHeaders,
} from "node:http";
import { isIP, type Socket } from "node:net";
import { connect as connectSecurely, rootCertificates } from "node:tls";
import {
    EGRESS_DECISION_HEADER,
    EgressDecisionMark,
    parseEgressDecisionMark,
} from "../egress-proxy/requests/EgressDecisionHeader.ts";
import type { EgressProxy } from "../egress-proxy/EgressProxy.ts";
import { bareHost } from "../egress-proxy/addresses/BareHost.ts";

// The request's headers as name and value text, in the declaration's order, for writing on the wire.
export const headerFields = (
    headers: readonly ServiceRequestHeader[],
): readonly (readonly [string, string])[] =>
    headers.map(
        (header) =>
            [
                header.name,
                typeof header.value === "string" ? header.value : reveal(header.value),
            ] as const,
    );

// The request's body as the text sent: its parts joined, each secret written as one JSON string, so
// a value can never change the body's shape.
export const bodyText = (body: ServiceRequest["body"]): string | null =>
    body === null
        ? null
        : body.jsonParts
              .map((part) => (typeof part === "string" ? part : JSON.stringify(reveal(part))))
              .join("");

// A workload's declared variables as name and value text, in the declaration's order, for writing
// into its container's environment.
export const variableFields = (
    variables: readonly WorkloadVariable[],
): readonly (readonly [string, string])[] =>
    variables.map(
        (variable) =>
            [
                variable.name,
                typeof variable.value === "string" ? variable.value : reveal(variable.value),
            ] as const,
    );

// ---- The real caller ----------------------------------------------------------------------------

export type ServiceCallerTimeouts = {
    // The longest any one call may take, whatever its request asks for. Two minutes unless given,
    // the longest timeout a declaration may set.
    readonly longestCallMilliseconds?: number;
};

export type ServiceCallerOptions = {
    // The running egress proxy; only its address is used.
    readonly proxy: Pick<EgressProxy, "url">;
    readonly timeouts?: ServiceCallerTimeouts;
    // PEM certificates trusted for HTTPS besides the system's own, such as a test certificate
    // authority. None unless given.
    readonly trustedCertificates?: readonly string[] | undefined;
};

const LONGEST_CALL_MILLISECONDS = 120_000;

type CallResult = Result<ServiceResponse, ServiceCallErrorCode>;

// Where the proxy listens: its host, without IPv6 brackets, and its port.
type ProxyAddress = { readonly host: string; readonly port: number };
// The certificate authorities TLS checks a service against: the system's own unless more are
// given, since naming any replaces the system's list.
type TrustedAuthorities = readonly string[] | undefined;

export function serviceCaller(options: ServiceCallerOptions): ServiceCaller {
    const proxyUrl = new URL(options.proxy.url);
    const proxy: ProxyAddress = {
        host: bareHost(proxyUrl.hostname),
        port: Number(proxyUrl.port === "" ? 80 : proxyUrl.port),
    };
    const longest = options.timeouts?.longestCallMilliseconds ?? LONGEST_CALL_MILLISECONDS;
    const authorities: TrustedAuthorities =
        options.trustedCertificates === undefined || options.trustedCertificates.length === 0
            ? undefined
            : [...rootCertificates, ...options.trustedCertificates];
    return {
        call: (request) =>
            sendOnce(request, proxy, Math.min(request.timeoutMilliseconds, longest), authorities),
    };
}

// The headers written on the wire: the declared ones, then the Host the origin names, and the JSON
// body's type and length when there is a body.
function wireHeaders(
    request: ServiceRequest,
    target: URL,
    body: string | null,
): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of headerFields(request.headers)) {
        headers[name.toLowerCase()] = value;
    }
    headers["host"] = target.host;
    if (body !== null) {
        headers["content-type"] ??= "application/json";
        headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
    }
    return headers;
}

// Sends `request` once through the proxy and reads the answer, settling exactly once: with the
// response, or with the first failure, whichever comes first. Settling closes every connection it
// opened, so a timed-out or oversized answer stops arriving.
function sendOnce(
    request: ServiceRequest,
    proxy: ProxyAddress,
    timeoutMilliseconds: number,
    authorities: TrustedAuthorities,
): Promise<CallResult> {
    return new Promise<CallResult>((resolve) => {
        const opened: (ClientRequest | Socket)[] = [];
        let settled = false;
        const finish = (result: CallResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            for (const connection of opened) {
                connection.destroy();
            }
            resolve(result);
        };
        const timer = setTimeout(() => finish(failure("call-timeout")), timeoutMilliseconds);

        // The origin and path are joined as text, never resolved as a URL, so a path such as "//host"
        // cannot name another host.
        if (!request.pathAndQuery.startsWith("/")) {
            finish(failure("parameter-invalid"));
            return;
        }
        let target: URL;
        try {
            target = new URL(`${request.origin}${request.pathAndQuery}`);
        } catch {
            finish(failure("parameter-invalid"));
            return;
        }
        const body = bodyText(request.body);
        const headers = wireHeaders(request, target, body);
        const onServiceAnswer = (answer: IncomingMessage): void =>
            readAnswer(answer, request.maximumResponseBytes, finish);
        const onProxyAnswer = (answer: IncomingMessage): void => {
            if (!finishWithProxyMark(answer, finish)) {
                onServiceAnswer(answer);
            }
        };
        const track = (connection: ClientRequest | Socket): void => {
            opened.push(connection);
            // A failure to reach the proxy, or a dropped connection, before an answer has been read.
            connection.on("error", () => finish(failure("service-unreachable")));
        };

        try {
            if (target.protocol === "http:") {
                // Plain HTTP goes to the proxy in absolute form, which the proxy vets and forwards.
                const outgoing = sendHttpRequest({
                    host: proxy.host,
                    port: proxy.port,
                    method: request.method,
                    path: `${request.origin}${request.pathAndQuery}`,
                    headers,
                    agent: false,
                });
                track(outgoing);
                outgoing.on("response", onProxyAnswer);
                outgoing.end(body ?? undefined);
            } else if (target.protocol === "https:") {
                sendThroughTunnel(
                    request,
                    target,
                    headers,
                    body,
                    { proxy, authorities },
                    track,
                    onServiceAnswer,
                    finish,
                );
            } else {
                // The proxy forwards only HTTP and HTTPS, so any other scheme is refused here.
                finish(failure("egress-blocked"));
            }
        } catch {
            // Node refuses, as the request is built, a header it cannot write, such as a value holding a
            // control character. Its message names the header, never the value, and none of it is kept.
            finish(failure("parameter-invalid"));
        }
    });
}

// HTTPS: the proxy opens a CONNECT tunnel to the address it vetted, and TLS runs inside it, end to
// end with the service. Every answer to CONNECT is the proxy's own: 403 is its refusal, anything
// else but 200 is its failure to connect.
function sendThroughTunnel(
    request: ServiceRequest,
    target: URL,
    headers: OutgoingHttpHeaders,
    body: string | null,
    route: { readonly proxy: ProxyAddress; readonly authorities: TrustedAuthorities },
    track: (connection: ClientRequest | Socket) => void,
    onResponse: (answer: IncomingMessage) => void,
    finish: (result: CallResult) => void,
): void {
    const authority = `${target.hostname}:${target.port === "" ? "443" : target.port}`;
    const { proxy, authorities } = route;
    const tunnelRequest = sendHttpRequest({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: authority,
        headers: { host: authority },
        agent: false,
    });
    track(tunnelRequest);
    tunnelRequest.on("connect", (answer: IncomingMessage, tunnel: Socket) => {
        track(tunnel);
        if (answer.statusCode !== 200) {
            finish(failure(answer.statusCode === 403 ? "egress-blocked" : "service-unreachable"));
            return;
        }
        try {
            const hostname = bareHost(target.hostname);
            const secure = connectSecurely({
                socket: tunnel,
                host: hostname,
                ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
                ...(authorities === undefined ? {} : { ca: [...authorities] }),
            });
            track(secure);
            const outgoing = sendHttpRequest({
                method: request.method,
                path: request.pathAndQuery,
                headers,
                createConnection: () => secure,
            });
            track(outgoing);
            outgoing.on("response", onResponse);
            outgoing.end(body ?? undefined);
        } catch {
            // As for plain HTTP: a header Node cannot write.
            finish(failure("parameter-invalid"));
        }
    });
    tunnelRequest.end();
}

const FAILURE_OF_MARK = {
    [EgressDecisionMark.Blocked]: "egress-blocked",
    [EgressDecisionMark.Unreachable]: "service-unreachable",
} as const satisfies Record<EgressDecisionMark, string>;

// A plain-HTTP answer the proxy marked as its own is its refusal or failure. Says whether this one
// was, and if so has finished the call. A mark means nothing on an answer from inside a tunnel, so
// only plain-HTTP answers come here.
function finishWithProxyMark(
    answer: IncomingMessage,
    finish: (result: CallResult) => void,
): boolean {
    const mark = answer.headers[EGRESS_DECISION_HEADER];
    if (mark === undefined) {
        return false;
    }
    answer.on("error", () => finish(failure("service-unreachable")));
    finish(failure(FAILURE_OF_MARK[parseEgressDecisionMark(mark)]));
    return true;
}

// Reads one answer of the service's, returned with its status as received, a redirect included. The
// body is read one byte past `maximumResponseBytes` and no further: only the engine can say what a
// status means, so a longer one answers with its status and the body cut there, and the connection is
// closed.
function readAnswer(
    answer: IncomingMessage,
    maximumResponseBytes: number,
    finish: (result: CallResult) => void,
): void {
    answer.on("error", () => finish(failure("service-unreachable")));
    const chunks: Buffer[] = [];
    let length = 0;
    const finishWithBody = (body: Buffer): void => {
        finish(
            success({
                status: answer.statusCode ?? 0,
                mediaType: answer.headers["content-type"] ?? null,
                body: new Uint8Array(body),
            }),
        );
    };
    answer.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length > maximumResponseBytes) {
            finishWithBody(Buffer.concat(chunks).subarray(0, maximumResponseBytes + 1));
        }
    });
    answer.on("end", () => {
        finishWithBody(Buffer.concat(chunks));
    });
    // A connection that closes before the body ends: the service or the proxy dropped it.
    answer.on("close", () => finish(failure("service-unreachable")));
}
