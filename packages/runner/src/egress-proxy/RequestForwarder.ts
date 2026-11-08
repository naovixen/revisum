import { EgressDecision } from "@revisum/contracts";
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { pipedDelivery, rewritingDelivery, type AnswerDelivery } from "./AnswerDelivery.ts";
import type { ClientTreatment } from "./ClientTreatment.ts";
import { EgressDecisionMark } from "./EgressDecisionHeader.ts";
import { forwardedHeaders } from "./ForwardedHeaders.ts";
import { abortedOnClose } from "./OpenSockets.ts";
import type { DeclarationLookup } from "./OriginDeclaration.ts";
import { GateOutcomeKind, type OutboundGate } from "./OutboundGate.ts";
import { parseRequestTarget, RequestTargetKind, type RequestTarget } from "./ParseRequestTarget.ts";
import type { ProxyRecord } from "./ProxyRecord.ts";
import type { RewriteRule } from "./ProxyRules.ts";

// Carries one plain-HTTP request through the proxy, or ends it as the client's treatment says.
export type RequestForwarder = (
    incoming: IncomingMessage,
    response: ServerResponse,
    treatment: ClientTreatment,
) => Promise<void>;

type RequestForwarderPorts = {
    readonly declarationOf: DeclarationLookup;
    readonly gate: OutboundGate;
    readonly rewrites: readonly RewriteRule[];
    readonly record: Pick<ProxyRecord, "noteDecision" | "noteRewriteApplied">;
};

type Exchange = {
    readonly incoming: IncomingMessage;
    readonly response: ServerResponse;
    readonly treatment: ClientTreatment;
};

type PlainHttpTarget = Extract<RequestTarget, { kind: typeof RequestTargetKind.PlainHttp }>;

const NOT_FORWARDED_STATUS = 400;
const REFUSED_STATUS = 403;
const BAD_GATEWAY_STATUS = 502;
const SERVICE_DID_NOT_ANSWER = "the service did not answer";

// A client's parser passes on any three digits, such as 000, and Node's server throws on a status
// outside this range, which from inside a handler would end the proxy for every other request.
const isWritableStatus = (status: number): boolean => status >= 100 && status <= 999;

function declineAsUnreachable(exchange: Exchange, text: string): void {
    exchange.treatment.declineRequest(
        exchange.response,
        BAD_GATEWAY_STATUS,
        EgressDecisionMark.Unreachable,
        text,
    );
}

function endOnUpstreamFailure(upstream: ClientRequest, exchange: Exchange): void {
    const { response } = exchange;
    upstream.on("error", () => {
        if (response.destroyed) {
            return;
        }
        if (response.headersSent) {
            response.destroy();
        } else {
            declineAsUnreachable(exchange, SERVICE_DID_NOT_ANSWER);
        }
    });
}

function carryRequest(
    exchange: Exchange,
    target: PlainHttpTarget,
    socket: Socket,
    delivery: AnswerDelivery,
): void {
    const { incoming, response, treatment } = exchange;
    const upstream = request({
        method: incoming.method,
        path: target.path,
        headers: delivery.requestHeaders(forwardedHeaders(incoming.headers, target.authority)),
        createConnection: () => socket,
    });
    // A request's timeout option never reaches a socket from createConnection, so the limit goes on the socket.
    socket.setTimeout(treatment.idleLimitMilliseconds, () => {
        upstream.destroy(new Error("the upstream server did not answer"));
    });
    endOnUpstreamFailure(upstream, exchange);
    // A client that leaves early, such as one that stops reading at its size cap or gives up at its
    // timeout, ends the service's connection too, so the service stops sending.
    response.on("close", () => {
        if (!response.writableFinished) {
            upstream.destroy();
        }
    });
    upstream.on("response", (answer) => {
        const status = answer.statusCode ?? BAD_GATEWAY_STATUS;
        if (!isWritableStatus(status)) {
            declineAsUnreachable(exchange, "the service sent a status HTTP does not have");
            upstream.destroy();
            return;
        }
        delivery.deliver(answer, status);
    });
    incoming.pipe(upstream);
}

export function createRequestForwarder(ports: RequestForwarderPorts): RequestForwarder {
    const { declarationOf, gate, rewrites, record } = ports;
    const deliveryFor = (response: ServerResponse, origin: string): AnswerDelivery => {
        const originRewrites = rewrites.filter((rule) => rule.origin === origin);
        return originRewrites.length === 0
            ? pipedDelivery(response)
            : rewritingDelivery(response, origin, originRewrites, record.noteRewriteApplied);
    };
    return async (incoming, response, treatment) => {
        const abandoned = abortedOnClose(response);
        const target = parseRequestTarget(incoming.url);
        if (target.kind === RequestTargetKind.NotForwardable) {
            record.noteDecision(target.recordedAs, EgressDecision.Blocked, treatment.client);
            treatment.declineRequest(
                response,
                NOT_FORWARDED_STATUS,
                EgressDecisionMark.Blocked,
                "not a request the egress proxy forwards",
            );
            return;
        }
        const outcome = await gate(
            {
                seen: target.origin,
                host: target.host,
                port: target.port,
                declaration: declarationOf(target.origin),
                client: treatment.client,
            },
            abandoned,
        );
        const exchange = { incoming, response, treatment };
        if (outcome.kind === GateOutcomeKind.Refused) {
            treatment.declineRequest(
                response,
                REFUSED_STATUS,
                EgressDecisionMark.Blocked,
                "blocked by the egress proxy",
            );
        } else if (outcome.kind === GateOutcomeKind.Unreachable) {
            declineAsUnreachable(exchange, SERVICE_DID_NOT_ANSWER);
        } else {
            carryRequest(exchange, target, outcome.socket, deliveryFor(response, target.origin));
        }
    };
}
