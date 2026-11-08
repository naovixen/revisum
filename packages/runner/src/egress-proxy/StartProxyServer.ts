import { hostAndPort, success, type Result } from "@revisum/contracts";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { directConnector, type AddressConnector } from "./AddressConnector.ts";
import { systemResolver, type AddressResolver } from "./AddressResolver.ts";
import { createAddressVetter } from "./AddressVetter.ts";
import { TREATMENT_OF_CLIENT } from "./ClientTreatment.ts";
import { connectingInTurn } from "./ConnectInTurn.ts";
import type { EgressProxy } from "./EgressProxy.ts";
import { createOpenSockets } from "./OpenSockets.ts";
import { declarationLookup } from "./OriginDeclaration.ts";
import { createOutboundGate } from "./OutboundGate.ts";
import { ProxyClient } from "./ProxyClient.ts";
import { createProxyListeners, type PlannedListener } from "./ProxyListeners.ts";
import { createProxyRecord, type ProxyRecordListeners } from "./ProxyRecord.ts";
import type { ProxyRules } from "./ProxyRules.ts";
import type { ProxyStartFailure } from "./ProxyStartFailure.ts";
import { createTcpConnectionRelay } from "./RelayTcpConnection.ts";
import { createRequestForwarder } from "./RequestForwarder.ts";
import { createTunnelOpener } from "./TunnelOpener.ts";

export type ProxyServerOptions = ProxyRecordListeners & {
    // A service unless given.
    readonly client?: ProxyClient;
    readonly resolve?: AddressResolver | undefined;
    readonly connect?: AddressConnector | undefined;
    // Where the proxy listens: 127.0.0.1 on a free port unless given.
    readonly listenHost?: string;
    readonly port?: number;
    // A second port on the same proxy, with the same rules and the same record, whose clients are
    // services, whatever `client` says of the first. Listening when the first port answers.
    readonly servicePort?: number;
};

const LOOPBACK_LISTEN_HOST = "127.0.0.1";
const ANY_FREE_PORT = 0;

// Starts a proxy from rules the parser has read. Never rejects: a port that can't be listened on is a
// failed outcome, with every listener already opened closed again.
export async function startProxyServer(
    rules: ProxyRules,
    options: ProxyServerOptions = {},
): Promise<Result<EgressProxy, ProxyStartFailure>> {
    const record = createProxyRecord(options);
    const sockets = createOpenSockets();
    const gate = createOutboundGate({
        vetAddresses: createAddressVetter(options.resolve ?? systemResolver),
        connectInTurn: connectingInTurn(options.connect ?? directConnector, sockets),
        record,
    });
    const forward = createRequestForwarder({
        declarationOf: declarationLookup(rules, (origin) => origin),
        gate,
        rewrites: rules.rewrites,
        record,
    });
    const openTunnel = createTunnelOpener({
        declarationOf: declarationLookup(rules, hostAndPort),
        gate,
        sockets,
        record,
    });
    const relayConnection = createTcpConnectionRelay({ gate, sockets });

    const proxyServerFor = (client: ProxyClient): Server => {
        const treatment = TREATMENT_OF_CLIENT[client];
        const server = createServer((incoming, response) => {
            void forward(incoming, response, treatment);
        });
        server.on("connect", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
            void openTunnel(incoming, socket, head, treatment);
        });
        return server;
    };

    // Each relay listens before the proxy's own port does, so a proxy that answers relays too. The
    // proxy's own port comes last, so its port is the one given back.
    const planned: readonly PlannedListener[] = [
        ...(rules.tcpRelays ?? []).map((relay) => ({
            server: createTcpServer((client) => {
                void relayConnection(client, relay);
            }),
            port: relay.port,
        })),
        ...(options.servicePort === undefined
            ? []
            : [{ server: proxyServerFor(ProxyClient.Service), port: options.servicePort }]),
        {
            server: proxyServerFor(options.client ?? ProxyClient.Service),
            port: options.port ?? ANY_FREE_PORT,
        },
    ];
    const listenHost = options.listenHost ?? LOOPBACK_LISTEN_HOST;
    const listeners = createProxyListeners({
        listenHost,
        sockets,
        noteFailure: record.noteListenerFailure,
    });
    const listening = await listeners.openInOrder(planned);
    if (!listening.ok) {
        return listening;
    }
    return success({
        url: `http://${listenHost}:${listening.value}`,
        decisions: record.decisions,
        refusedOrigins: record.refusedOrigins,
        rewritesApplied: record.rewritesApplied,
        connectionFailures: record.connectionFailures,
        listenerFailures: record.listenerFailures,
        close: listeners.close,
    });
}
