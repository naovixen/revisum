import type { DeclaredService, EgressPolicy } from "@revisum/contracts";
import { bareHost, type BareHost } from "./BareHost.ts";

// A TCP port the proxy relays: it listens on `port` and connects each client to `host` at the same
// port. `private` says the host may resolve to a private address, as for a service declared private.
export type TcpRelay = {
    readonly host: BareHost;
    readonly port: number;
    readonly private: boolean;
};

type RelayedService = DeclaredService & { readonly port: number };

// The one selection of the services a policy allows over TCP: each with its declared port.
export const relayedServices = (
    policy: EgressPolicy,
    services: readonly DeclaredService[],
): readonly RelayedService[] =>
    services.filter(
        (service): service is RelayedService =>
            policy.allowTcpServices.includes(service.name) && service.port !== undefined,
    );

// The relays those services need, each by the host its origin names and its declared port.
export function tcpRelaysFor(
    policy: EgressPolicy,
    services: readonly DeclaredService[],
): readonly TcpRelay[] {
    return relayedServices(policy, services).map((service) => ({
        host: bareHost(new URL(service.origin).hostname),
        port: service.port,
        private: service.private,
    }));
}

// How a relay's decisions name what was reached: "host:port", an IPv6 host in brackets.
export const relayOrigin = (relay: TcpRelay): string =>
    `${relay.host.includes(":") ? `[${relay.host}]` : relay.host}:${relay.port}`;
