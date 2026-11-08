import type { DeclaredService, EgressPolicy } from "@revisum/contracts";
import { bareHost } from "./BareHost.ts";

// A TCP port the proxy relays: it listens on `port` and connects each client to `host` at the same
// port. `private` says the host may resolve to a private address, as for a service declared private.
export type TcpRelay = { readonly host: string; readonly port: number; readonly private: boolean };

// The services a policy allows over TCP, each by the host its origin names and its declared port.
export function tcpRelaysFor(
    policy: EgressPolicy,
    services: readonly DeclaredService[],
): readonly TcpRelay[] {
    return services.flatMap((service) =>
        policy.allowTcpServices.includes(service.name) && service.port !== undefined
            ? [
                  {
                      host: bareHost(new URL(service.origin).hostname),
                      port: service.port,
                      private: service.private,
                  },
              ]
            : [],
    );
}

// How a relay's decisions name what was reached: "host:port", an IPv6 host in brackets.
export const relayOrigin = (relay: TcpRelay): string =>
    `${relay.host.includes(":") ? `[${relay.host}]` : relay.host}:${relay.port}`;
