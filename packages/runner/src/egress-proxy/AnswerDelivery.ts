import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { answerHeaders } from "./ForwardedHeaders.ts";
import type { ProxyRecord } from "./ProxyRecord.ts";
import type { RewriteRule } from "./ProxyRules.ts";
import { rewriteBody } from "./RewriteBody.ts";

// How a service's answer reaches the client.
export type AnswerDelivery = {
    // The headers to send upstream, given the ones the proxy would forward anyway.
    readonly requestHeaders: (forwarded: IncomingHttpHeaders) => IncomingHttpHeaders;
    readonly deliver: (answer: IncomingMessage, status: number) => void;
};

export const pipedDelivery = (response: ServerResponse): AnswerDelivery => ({
    requestHeaders: (forwarded) => forwarded,
    deliver: (answer, status) => {
        response.writeHead(status, answerHeaders(answer.headers));
        answer.pipe(response);
    },
});

// Holds the whole body back so the rewrites can change it, which needs it uncompressed.
export const rewritingDelivery = (
    response: ServerResponse,
    origin: string,
    rewrites: readonly RewriteRule[],
    noteRewriteApplied: ProxyRecord["noteRewriteApplied"],
): AnswerDelivery => ({
    requestHeaders: (forwarded) => ({ ...forwarded, "accept-encoding": "identity" }),
    deliver: (answer, status) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
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
        });
    },
});
