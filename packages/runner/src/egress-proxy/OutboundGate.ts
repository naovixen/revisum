import { EgressDecision } from "@revisum/contracts";
import type { Socket } from "node:net";
import { isLoopbackAddress } from "../address-check.ts";
import { VettingKind, type AddressVetter, type ReachableVetting } from "./AddressVetter.ts";
import type { BareHost } from "./BareHost.ts";
import type { ConnectInTurn } from "./ConnectInTurn.ts";
import type { OriginDeclaration } from "./OriginDeclaration.ts";
import type { ProxyClient } from "./ProxyClient.ts";
import type { ProxyRecord } from "./ProxyRecord.ts";

export const GateOutcomeKind = {
    // The target is undeclared, or a name resolved to an address it may not have. Recorded as blocked.
    Refused: "refused",
    // Recorded as allowed, but no connection opened. Why is in the connection failures, unless the
    // client left.
    Unreachable: "unreachable",
    Connected: "connected",
} as const;

export type GateOutcome =
    | { readonly kind: typeof GateOutcomeKind.Refused }
    | { readonly kind: typeof GateOutcomeKind.Unreachable }
    | { readonly kind: typeof GateOutcomeKind.Connected; readonly socket: Socket };

export type OutboundTarget = {
    // How decisions and connection failures name the target.
    readonly seen: string;
    readonly host: BareHost;
    readonly port: number;
    readonly declaration: OriginDeclaration;
    readonly client: ProxyClient;
};

// The one way anything leaves the proxy: vets the target, records the decision, and only then
// connects, to the addresses it vetted. `abandoned` aborts once whoever asked has gone.
export type OutboundGate = (target: OutboundTarget, abandoned: AbortSignal) => Promise<GateOutcome>;

type OutboundGatePorts = {
    readonly vetAddresses: AddressVetter;
    readonly connectInTurn: ConnectInTurn;
    readonly record: Pick<ProxyRecord, "noteDecision" | "noteConnectionFailure">;
};

// The proxy connects directly, on purpose, so a machine that reaches the network only through a proxy
// of its own can't connect out. Nothing the proxy sees tells that from a dead origin: a firewall can
// refuse, drop or fail a lookup just as a dead origin does, and a proxy setting in the environment
// says nothing about this connection. So the message names both. Loopback is the one certainty, since
// a connection to this machine never crosses a machine proxy.
function connectionFailureMessage(
    origin: string,
    vetting: ReachableVetting,
    failure: Error,
): string {
    const isOnThisMachine =
        vetting.kind === VettingKind.Checked && vetting.addresses.every(isLoopbackAddress);
    return isOnThisMachine
        ? `Nothing answered at ${origin} (${failure.message}).`
        : `Could not connect to ${origin} (${failure.message}). Either nothing answers there, or this machine reaches the network only through a proxy, and a machine proxy isn't supported yet.`;
}

export function createOutboundGate(ports: OutboundGatePorts): OutboundGate {
    const { vetAddresses, connectInTurn, record } = ports;
    return async (target, abandoned) => {
        const vetting = await vetAddresses(target.host, target.declaration);
        if (vetting.kind === VettingKind.Refused) {
            record.noteDecision(target.seen, EgressDecision.Blocked, target.client);
            return { kind: GateOutcomeKind.Refused };
        }
        record.noteDecision(target.seen, EgressDecision.Allowed, target.client);
        const connection =
            vetting.kind === VettingKind.NoAddress
                ? vetting.failure
                : await connectInTurn(vetting.addresses, target.port, abandoned);
        if (!(connection instanceof Error)) {
            return { kind: GateOutcomeKind.Connected, socket: connection };
        }
        if (!abandoned.aborted) {
            record.noteConnectionFailure(
                target.seen,
                connectionFailureMessage(target.seen, vetting, connection),
            );
        }
        return { kind: GateOutcomeKind.Unreachable };
    };
}
