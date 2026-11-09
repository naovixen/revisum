// An HTTP proxy on loopback that notes the host of everything asked of it and sends nothing onward.
// A browser told to use it can ask for any address in the world without a byte leaving the machine:
// a request gets a refusal, and a tunnel is accepted only to read what the browser sends first.
//
// The one exception is the host it is told to relay, the test's own page server on loopback, since a
// browser context's proxy carries the page's own requests too. Those are noted apart, and only plain
// requests to that host are carried.
import { createServer, request as sendRequest, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type RecordingProxy = {
    readonly server: string;
    // The hosts asked for since the last forgetAskedHosts, in order, without the relayed host.
    askedHosts(): readonly string[];
    // The hosts whose tunnel carried the opening bytes of a TLS handshake, so the browser went on
    // with the connection as soon as it was offered.
    tunnelledHosts(): readonly string[];
    // The urls of the requests carried to the relayed host since the last forgetAskedHosts, in order.
    relayedRequests(): readonly string[];
    forgetAskedHosts(): void;
    close(): Promise<void>;
};

export type RecordingProxyOptions = {
    // The host whose plain requests are carried to it rather than refused.
    readonly relayedHost?: string;
};

const TLS_HANDSHAKE_RECORD = 0x16;

// A request names its host in a whole URL, and a tunnel as host:port.
const hostOfAsked = (asked: string): string =>
    new URL(asked.includes("://") ? asked : `http://${asked}`).hostname;

function relay(
    url: string,
    method: string | undefined,
    incoming: NodeJS.ReadableStream,
    response: ServerResponse,
): void {
    const target = new URL(url);
    const outgoing = sendRequest(target, { method, headers: { connection: "close" } }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
    });
    outgoing.on("error", () => response.destroy());
    incoming.pipe(outgoing);
}

export async function startRecordingProxy(
    options: RecordingProxyOptions = {},
): Promise<RecordingProxy> {
    let asked: string[] = [];
    let tunnelled: string[] = [];
    let relayed: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
        const url = request.url ?? "";
        const host = hostOfAsked(url);
        if (host === options.relayedHost) {
            relayed.push(url);
            relay(url, request.method, request, response);
            return;
        }
        asked.push(host);
        response.writeHead(403).end();
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.on("connect", (request, socket) => {
        const host = hostOfAsked(request.url ?? "");
        asked.push(host);
        socket.on("error", () => undefined);
        socket.once("data", (firstBytes: Buffer) => {
            if (firstBytes[0] === TLS_HANDSHAKE_RECORD) {
                tunnelled.push(host);
            }
            socket.destroy();
        });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        server: `http://127.0.0.1:${port}`,
        askedHosts: () => [...asked],
        tunnelledHosts: () => [...tunnelled],
        relayedRequests: () => [...relayed],
        forgetAskedHosts: () => {
            asked = [];
            tunnelled = [];
            relayed = [];
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}
