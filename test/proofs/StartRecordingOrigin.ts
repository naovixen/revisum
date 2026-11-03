// A real server on one loopback address that notes everything that arrives at it: each connection,
// each request, each WebSocket handshake and each datagram. An address that is otherwise silent is
// how a test sees a browser's traffic get through, whatever the browser itself reports.
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type RecordingOrigin = {
    readonly origin: string;
    readonly hostname: string;
    readonly port: number;
    readonly datagramPort: number;
    // What has arrived since the last forgetArrivals, in order.
    arrivals(): readonly string[];
    forgetArrivals(): void;
    close(): Promise<void>;
};

export const Arrival = {
    Connection: "connection",
    Datagram: "datagram",
} as const;

export const requestArrival = (path: string, method = "GET"): string => `${method} ${path}`;
export const websocketArrival = (path: string): string => `websocket ${path}`;

const WEBSOCKET_ACCEPT_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// A frame that, when given an address, asks it for a file as soon as it loads.
const FRAME_PATH = "/frame.html";
const framePage = (fetchedUrl: string | null): string => `<!doctype html><html lang="en">
  <head><meta charset="utf-8"><title>Frame</title></head>
  <body><p>Frame</p>${fetchedUrl === null ? "" : `<script>fetch(${JSON.stringify(fetchedUrl)}, { mode: "no-cors" });</script>`}</body></html>`;

export const framePath = (fetchedUrl?: string): string =>
    fetchedUrl === undefined ? FRAME_PATH : `${FRAME_PATH}?to=${encodeURIComponent(fetchedUrl)}`;

export async function startRecordingOrigin(hostname: string): Promise<RecordingOrigin> {
    let arrived: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        arrived.push(requestArrival(url.pathname, request.method));
        if (url.pathname === FRAME_PATH) {
            response
                .writeHead(200, { "content-type": "text/html; charset=utf-8" })
                .end(framePage(url.searchParams.get("to")));
            return;
        }
        response.writeHead(200, { "cache-control": "no-store" }).end("recorded");
    });
    server.on("connection", (socket) => {
        arrived.push(Arrival.Connection);
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket) => {
        arrived.push(websocketArrival(new URL(request.url ?? "/", "http://localhost").pathname));
        const accept = createHash("sha1")
            .update(`${request.headers["sec-websocket-key"] ?? ""}${WEBSOCKET_ACCEPT_SUFFIX}`)
            .digest("base64");
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, hostname, resolve));
    const datagrams = createSocket("udp4");
    datagrams.on("message", () => {
        arrived.push(Arrival.Datagram);
    });
    await new Promise<void>((resolve) => {
        datagrams.bind(0, hostname, resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://${hostname}:${port}`,
        hostname,
        port,
        datagramPort: datagrams.address().port,
        arrivals: () => [...arrived],
        forgetArrivals: () => {
            arrived = [];
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => {
                datagrams.close(resolve);
            });
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}
