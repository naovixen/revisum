import type { Brand, Origin, ResponseRewrite } from "@revisum/contracts";
import type { TcpRelay } from "../tunnels/TcpRelay.ts";

// A change the proxy makes to plain-HTTP response bodies from one declared origin.
export type RewriteRule = { readonly origin: string; readonly rewrite: ResponseRewrite };

// A rewrite rule the parser has read, so its origin is a declared plain-HTTP one.
export type ParsedRewriteRule = RewriteRule & { readonly origin: Origin };

// What the proxy enforces. Only parseProxyRules makes one.
export type ProxyRules = Brand<
    {
        // Every origin a request may reach: the policy's origins and its services' origins.
        readonly allowedOrigins: readonly Origin[];
        // The origins of services declared private, which may resolve to private addresses. An origin
        // here that is not also in `allowedOrigins` is still refused.
        readonly privateOrigins: readonly Origin[];
        readonly rewrites: readonly ParsedRewriteRule[];
        // Empty unless the policy allows a service over TCP.
        readonly tcpRelays: readonly TcpRelay[];
    },
    "ProxyRules"
>;
