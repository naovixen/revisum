import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { answerHeaders } from "./ForwardedHeaders.ts";
import type { ProxyRecord } from "../ProxyRecord.ts";
import type { RewriteRule } from "../rules/ProxyRules.ts";
import { rewriteBody } from "./RewriteBody.ts";

// How a service's answer reaches the client.
export type AnswerDelivery = {
    // The headers to send upstream, given the ones the proxy would forward anyway.
    readonly requestHeaders: (forwarded: IncomingHttpHeaders) => IncomingHttpHeaders;
    readonly deliver: (answer: IncomingMessage, status: number) => void;
};

// Destroys the client's response if the service's answer ends incomplete, since nothing else tells a
// client that the body was cut. Gives a function that stops watching.
function destroyingResponseWhenCut(answer: IncomingMessage, response: ServerResponse): () => void {
    const onAnswerClosed = (): void => {
        if (!answer.complete) {
            response.destroy();
        }
    };
    answer.once("close", onAnswerClosed);
    return () => {
        answer.off("close", onAnswerClosed);
    };
}

export const pipedDelivery = (response: ServerResponse): AnswerDelivery => ({
    requestHeaders: (forwarded) => forwarded,
    deliver: (answer, status) => {
        destroyingResponseWhenCut(answer, response);
        response.writeHead(status, answerHeaders(answer.headers));
        answer.pipe(response);
    },
});

const HELD_BACK_LIMIT_BYTES = 32 * 1024 * 1024;

export type RewritingDeliveryPorts = {
    readonly response: ServerResponse;
    readonly origin: string;
    readonly rewrites: readonly RewriteRule[];
    readonly noteRewriteApplied: ProxyRecord["noteRewriteApplied"];
    // How an answer too long to hold back ends.
    readonly declineOversized: () => void;
};

// Holds the whole body back so the rewrites can change it, which needs it uncompressed.
export const rewritingDelivery = (ports: RewritingDeliveryPorts): AnswerDelivery => ({
    requestHeaders: (forwarded) => ({ ...forwarded, "accept-encoding": "identity" }),
    deliver: (answer, status) => {
        const { response, origin, rewrites, noteRewriteApplied, declineOversized } = ports;
        const stopWatchingForCut = destroyingResponseWhenCut(answer, response);
        const chunks: Buffer[] = [];
        let heldBytes = 0;
        // The answer may already have all arrived, so destroying it doesn't stop a later 'end'.
        const onChunk = (chunk: Buffer): void => {
            heldBytes += chunk.length;
            if (heldBytes > HELD_BACK_LIMIT_BYTES) {
                answer.off("data", onChunk);
                answer.off("end", onEnd);
                stopWatchingForCut();
                chunks.length = 0;
                answer.destroy();
                declineOversized();
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = (): void => {
            const rewritten = rewriteBody(
                Buffer.concat(chunks),
                rewrites.map((rule) => rule.rewrite),
            );
            for (const name of rewritten.appliedNames) {
                noteRewriteApplied(origin, name);
            }
            response
                .writeHead(status, {
                    ...answerHeaders(answer.headers),
                    "content-length": String(rewritten.body.length),
                })
                .end(rewritten.body);
        };
        answer.on("data", onChunk);
        answer.on("end", onEnd);
    },
});
