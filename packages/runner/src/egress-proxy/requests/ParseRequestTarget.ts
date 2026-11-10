import { bareHost, type BareHost } from "../addresses/BareHost.ts";
import { MALFORMED_REQUEST_ORIGIN } from "../MalformedRequestOrigin.ts";

export const RequestTargetKind = {
    PlainHttp: "plain-http",
    NotForwardable: "not-forwardable",
} as const;

// What a plain request's target says, parsed once where it arrives.
export type RequestTarget =
    | {
          readonly kind: typeof RequestTargetKind.NotForwardable;
          // How the refusal names it in the proxy's decisions.
          readonly recordedAs: string;
      }
    | {
          readonly kind: typeof RequestTargetKind.PlainHttp;
          readonly origin: string;
          readonly host: BareHost;
          // The Host the URL names, with its port if it has one.
          readonly authority: string;
          readonly port: number;
          readonly path: string;
      };

const DEFAULT_HTTP_PORT = 80;

export function parseRequestTarget(rawTarget: string | undefined): RequestTarget {
    const url = URL.parse(rawTarget ?? "");
    if (url === null) {
        return { kind: RequestTargetKind.NotForwardable, recordedAs: MALFORMED_REQUEST_ORIGIN };
    }
    if (url.protocol !== "http:") {
        return {
            kind: RequestTargetKind.NotForwardable,
            // The URL parser writes "null" as the origin of a scheme it does not know.
            recordedAs: url.origin === "null" ? MALFORMED_REQUEST_ORIGIN : url.origin,
        };
    }
    return {
        kind: RequestTargetKind.PlainHttp,
        origin: url.origin,
        host: bareHost(url.hostname),
        authority: url.host,
        port: url.port === "" ? DEFAULT_HTTP_PORT : Number(url.port),
        path: `${url.pathname}${url.search}`,
    };
}
