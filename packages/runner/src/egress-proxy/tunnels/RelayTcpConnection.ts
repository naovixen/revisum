import type { Socket } from "node:net";
import type { OpenSockets } from "../OpenSockets.ts";
import { OriginDeclaration } from "../addresses/OriginDeclaration.ts";
import { GateOutcomeKind, type OutboundGate } from "../addresses/OutboundGate.ts";
import { ProxyClient } from "../ProxyClient.ts";
import { relayOrigin, type TcpRelay } from "./TcpRelay.ts";

// Relays one client of a TCP relay's port: its bytes go, unread, to a vetted address of the relay's
// host, and the connection closes when that can't be done.
export type RelayTcpConnection = (client: Socket, relay: TcpRelay) => Promise<void>;

type RelayTcpConnectionPorts = {
    readonly gate: OutboundGate;
    readonly sockets: Pick<OpenSockets, "adoptClient">;
};

export function createTcpConnectionRelay(ports: RelayTcpConnectionPorts): RelayTcpConnection {
    const { gate, sockets } = ports;
    return async (client, relay) => {
        const abandoned = sockets.adoptClient(client);
        const outcome = await gate(
            {
                seen: relayOrigin(relay),
                host: relay.host,
                port: relay.port,
                declaration: relay.private ? OriginDeclaration.Private : OriginDeclaration.Public,
                client: ProxyClient.Service,
            },
            abandoned,
        );
        if (outcome.kind !== GateOutcomeKind.Connected) {
            client.destroy();
            return;
        }
        const upstream = outcome.socket;
        upstream.on("close", () => {
            client.destroy();
        });
        upstream.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
        upstream.pipe(client);
        client.pipe(upstream);
    };
}
