import { EgressDecision } from "@revisum/contracts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ClientTreatment } from "../requests/ClientTreatment.ts";
import type { OpenSockets } from "../OpenSockets.ts";
import type { DeclarationLookup } from "../addresses/OriginDeclaration.ts";
import { GateOutcomeKind, type OutboundGate } from "../addresses/OutboundGate.ts";
import { ConnectTargetKind, parseConnectTarget } from "./ParseConnectTarget.ts";
import type { ProxyRecord } from "../ProxyRecord.ts";

// Serves one CONNECT request: joins the client to its target, or ends it as its treatment says.
export type TunnelOpener = (
    incoming: IncomingMessage,
    client: Duplex,
    head: Buffer,
    treatment: ClientTreatment,
) => Promise<void>;

type TunnelOpenerPorts = {
    readonly declarationOf: DeclarationLookup;
    readonly gate: OutboundGate;
    readonly sockets: Pick<OpenSockets, "adoptClient">;
    readonly record: Pick<ProxyRecord, "noteDecision">;
};

export function createTunnelOpener(ports: TunnelOpenerPorts): TunnelOpener {
    const { declarationOf, gate, sockets, record } = ports;
    return async (incoming, client, head, treatment) => {
        const abandoned = sockets.adoptClient(client);
        const target = parseConnectTarget(incoming.url);
        if (target.kind === ConnectTargetKind.Malformed) {
            record.noteDecision(target.recordedAs, EgressDecision.Blocked, treatment.client);
            treatment.declineTunnel(client, "400 Bad Request");
            return;
        }
        const outcome = await gate(
            {
                seen: target.seen,
                host: target.host,
                port: target.port,
                declaration: declarationOf(target.seen),
                client: treatment.client,
            },
            abandoned,
        );
        if (outcome.kind === GateOutcomeKind.Refused) {
            treatment.declineTunnel(client, "403 Forbidden");
            return;
        }
        if (outcome.kind === GateOutcomeKind.Unreachable) {
            treatment.declineTunnel(client, "502 Bad Gateway");
            return;
        }
        const upstream = outcome.socket;
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
            upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
    };
}
