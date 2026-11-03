// An HTTP proxy on loopback that notes the host of everything asked of it and sends nothing onward.
// A browser told to use it can ask for any address in the world without a byte leaving the machine:
// a request gets a refusal, and a tunnel is accepted only to read what the browser sends first.
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type RecordingProxy = {
    readonly server: string;
    // The hosts asked for since the last forgetAskedHosts, in order.
    askedHosts(): readonly string[];
    // The hosts whose tunnel carried the opening bytes of a TLS handshake, so the browser went on
    // with the connection as soon as it was offered.
    tunnelledHosts(): readonly string[];
    forgetAskedHosts(): void;
    close(): Promise<void>;
};

const TLS_HANDSHAKE_RECORD = 0x16;

// A request names its host in a whole URL, and a tunnel as host:port.
const hostOfAsked = (asked: string): string =>
    new URL(asked.includes("://") ? asked : `http://${asked}`).hostname;

export async function startRecordingProxy(): Promise<RecordingProxy> {
    let asked: string[] = [];
    let tunnelled: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
        asked.push(hostOfAsked(request.url ?? ""));
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
        forgetAskedHosts: () => {
            asked = [];
            tunnelled = [];
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
