import type { DeclaredService, EgressPolicy, ResponseRewrite } from "@revisum/contracts";
import { tcpRelaysFor, type TcpRelay } from "./TcpRelay.ts";

// A change the proxy makes to plain-HTTP response bodies from one declared origin.
export type RewriteRule = { readonly origin: string; readonly rewrite: ResponseRewrite };

// What the proxy enforces, as plain text, so the proxy container can read it from its settings.
export type ProxyRules = {
    // Every origin a request may reach: the policy's origins and its services' origins.
    readonly allowedOrigins: readonly string[];
    // The origins of services declared private, which may resolve to private addresses. An origin
    // here that is not also in `allowedOrigins` is still refused.
    readonly privateOrigins: readonly string[];
    // Each origin must be in `allowedOrigins` and plain HTTP, or the proxy refuses to start.
    readonly rewrites: readonly RewriteRule[];
    // Present only when the policy allows a service over TCP.
    readonly tcpRelays?: readonly TcpRelay[];
};

// The proxy's rules for a policy: its origins, the origins of the services it allows, which of
// those services are private, its rewrites, and a TCP relay for each service it allows over TCP
// that declares a port.
export function proxyRules(
    policy: EgressPolicy,
    services: readonly DeclaredService[] = [],
): ProxyRules {
    const allowedServices = services.filter((service) =>
        policy.allowServices.includes(service.name),
    );
    const tcpRelays = tcpRelaysFor(policy, services);
    return {
        allowedOrigins: [
            ...new Set([
                ...policy.allowOrigins,
                ...allowedServices.map((service) => service.origin),
            ]),
        ],
        privateOrigins: allowedServices
            .filter((service) => service.private)
            .map((service) => service.origin),
        rewrites: (policy.responseRewrites ?? []).map((entry) => ({
            origin: entry.origin,
            rewrite: entry.rewrite,
        })),
        ...(tcpRelays.length === 0 ? {} : { tcpRelays }),
    };
}
