import { hostAndPort } from "@revisum/contracts";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { isPlainHttpOrigin } from "../egress-events.ts";
import {
    directConnector,
    systemResolver,
    type AddressConnector,
    type AddressResolver,
} from "./AddressResolver.ts";
import { createAddressVetter } from "./AddressVetter.ts";
import { TREATMENT_OF_CLIENT } from "./ClientTreatment.ts";
import { connectingInTurn } from "./ConnectInTurn.ts";
import type { EgressProxy } from "./EgressProxy.ts";
import { createRequestForwarder } from "./RequestForwarder.ts";
import { listenOn } from "./ListenOn.ts";
import { createOpenSockets } from "./OpenSockets.ts";
import { createTunnelOpener } from "./TunnelOpener.ts";
import { declarationLookup, OriginDeclaration } from "./OriginDeclaration.ts";
import { createOutboundGate } from "./OutboundGate.ts";
import { ProxyClient } from "./ProxyClient.ts";
import { createProxyRecord, type ProxyRecordListeners } from "./ProxyRecord.ts";
import type { ProxyRules } from "./ProxyRules.ts";
import { createTcpConnectionRelay, type RelayTcpConnection } from "./RelayTcpConnection.ts";
import type { TcpRelay } from "./TcpRelay.ts";

export type ProxyServerOptions = ProxyRecordListeners & {
    // A service unless given.
    readonly client?: ProxyClient;
    readonly resolve?: AddressResolver;
    readonly connect?: AddressConnector;
    // Where the proxy listens: 127.0.0.1 on a free port unless given.
    readonly listenHost?: string;
    readonly port?: number;
    // A second port on the same proxy, with the same rules and the same record, whose clients are
    // services, whatever `client` says of the first. Listening when the first port answers.
    readonly servicePort?: number;
};

const LOOPBACK_LISTEN_HOST = "127.0.0.1";
const ANY_FREE_PORT = 0;

// Each relay listens before the proxy's own port does, so a proxy that answers relays too.
async function listeningRelays(
    relays: readonly TcpRelay[],
    listenHost: string,
    relayConnection: RelayTcpConnection,
): Promise<readonly TcpServer[]> {
    const relayServers: TcpServer[] = [];
    try {
        for (const relay of relays) {
            const relayServer = createTcpServer((client) => {
                void relayConnection(client, relay);
            });
            relayServers.push(relayServer);
            await listenOn(relayServer, relay.port, listenHost);
        }
    } catch (error) {
        for (const relayServer of relayServers) {
            relayServer.close();
        }
        throw error;
    }
    return relayServers;
}

function portOf(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("the egress proxy's listener has no port");
    }
    return address.port;
}

const closedServer = (server: Server): Promise<void> =>
    new Promise<void>((resolveClosed) => {
        server.closeAllConnections();
        server.close(() => {
            resolveClosed();
        });
    });

// Starts a proxy from rules that are already plain text, as the proxy's container does. A rewrite of
// anything but a declared plain-HTTP origin, or a port that can't be listened on, rejects.
export async function startProxyServer(
    rules: ProxyRules,
    options: ProxyServerOptions = {},
): Promise<EgressProxy> {
    const declarationOfOrigin = declarationLookup(rules, (origin) => origin);
    const declarationOfHost = declarationLookup(rules, hostAndPort);
    // EgressPolicy is not branded, so a policy built by hand gets here without the builder's checks.
    const refusedRewrite = rules.rewrites.find(
        (rule) =>
            declarationOfOrigin(rule.origin) === OriginDeclaration.Undeclared ||
            !isPlainHttpOrigin(rule.origin),
    );
    if (refusedRewrite !== undefined) {
        throw new Error(
            `a response rewrite may change only a declared plain-HTTP origin, not ${refusedRewrite.origin}`,
        );
    }
    const record = createProxyRecord(options);
    const sockets = createOpenSockets();
    const gate = createOutboundGate({
        vetAddresses: createAddressVetter(options.resolve ?? systemResolver),
        connectInTurn: connectingInTurn(options.connect ?? directConnector, sockets),
        record,
    });
    const forward = createRequestForwarder({
        declarationOf: declarationOfOrigin,
        gate,
        rewrites: rules.rewrites,
        record,
    });
    const openTunnel = createTunnelOpener({
        declarationOf: declarationOfHost,
        gate,
        sockets,
        record,
    });
    const listenHost = options.listenHost ?? LOOPBACK_LISTEN_HOST;
    const relayServers = await listeningRelays(
        rules.tcpRelays ?? [],
        listenHost,
        createTcpConnectionRelay({ gate, sockets }),
    );
    const listeningFor = async (client: ProxyClient, port: number): Promise<Server> => {
        const treatment = TREATMENT_OF_CLIENT[client];
        const server = createServer((incoming, response) => {
            void forward(incoming, response, treatment);
        });
        server.on("connect", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
            void openTunnel(incoming, socket, head, treatment);
        });
        await listenOn(server, port, listenHost);
        return server;
    };
    const serviceServers =
        options.servicePort === undefined
            ? []
            : [await listeningFor(ProxyClient.Service, options.servicePort)];
    const server = await listeningFor(
        options.client ?? ProxyClient.Service,
        options.port ?? ANY_FREE_PORT,
    );
    return {
        url: `http://${listenHost}:${portOf(server)}`,
        decisions: record.decisions,
        rewritesApplied: record.rewritesApplied,
        connectionFailures: record.connectionFailures,
        close: async () => {
            sockets.destroyAll();
            for (const relayServer of relayServers) {
                relayServer.close();
            }
            await Promise.all([server, ...serviceServers].map(closedServer));
        },
    };
}
