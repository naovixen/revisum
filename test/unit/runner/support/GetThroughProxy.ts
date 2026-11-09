// Talking to the egress proxy the way a browser or a service call would: a plain-HTTP request in
// absolute form, or a CONNECT tunnel. And a stand-in upstream server, which a test's own connect
// function routes every allowed connection to, so no test reaches the network whatever address
// the proxy vetted.
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";

export type ProxiedAnswer = { readonly status: number; readonly body: string };

// The host part of an absolute URL exactly as written, for the Host header, so an unusual form
// such as "0x7f000001" reaches the proxy unchanged.
const writtenHost = (target: string): string =>
    target.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";

// Sends GET `target` (an absolute URL, sent exactly as written) to the proxy at `proxyUrl`.
export function getThroughProxy(
    proxyUrl: string,
    target: string,
    timeoutMilliseconds = 5000,
): Promise<ProxiedAnswer> {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                host: proxy.hostname,
                port: Number(proxy.port),
                method: "GET",
                path: target,
                headers: { host: writtenHost(target) },
                timeout: timeoutMilliseconds,
            },
            (response: IncomingMessage) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        outgoing.on("timeout", () =>
            outgoing.destroy(new Error(`no answer from the proxy for ${target}`)),
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}

// Asks the proxy to open a tunnel to `authority` ("host:port"), as a browser does for HTTPS and
// WebSockets, and returns the proxy's status. The tunnel, if any, is closed at once.
export function connectThroughProxy(
    proxyUrl: string,
    authority: string,
    timeoutMilliseconds = 5000,
): Promise<number> {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        const outgoing = request({
            host: proxy.hostname,
            port: Number(proxy.port),
            method: "CONNECT",
            path: authority,
            headers: { host: authority },
            timeout: timeoutMilliseconds,
        });
        outgoing.on("connect", (response: IncomingMessage, socket: Socket) => {
            socket.destroy();
            resolve(response.statusCode ?? 0);
        });
        outgoing.on("response", (response: IncomingMessage) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        outgoing.on("timeout", () =>
            outgoing.destroy(new Error(`no answer from the proxy for CONNECT ${authority}`)),
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}

// Writes `text` to the proxy over a socket of its own and returns every byte the proxy sent before it
// closed the socket, so a test can tell an answer from a socket closed without one. A proxy that keeps
// the socket open past the limit fails the exchange.
export function exchangeWithProxy(
    proxyUrl: string,
    text: string,
    timeoutMilliseconds = 5000,
): Promise<string> {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let isLeftOpen = false;
        const socket = connect(Number(proxy.port), proxy.hostname);
        socket.setTimeout(timeoutMilliseconds, () => {
            isLeftOpen = true;
            socket.destroy();
        });
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        // A reset is the proxy closing the socket too.
        socket.on("error", () => undefined);
        socket.on("close", () => {
            if (isLeftOpen) {
                reject(new Error(`the proxy left the socket open after: ${text}`));
            } else {
                resolve(Buffer.concat(chunks).toString("latin1"));
            }
        });
        socket.write(text);
    });
}

export const plainRequestText = (target: string): string =>
    `GET ${target}/ HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: close\r\n\r\n`;

export const tunnelRequestText = (authority: string): string =>
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;

export const UPSTREAM_BODY = "reached the upstream server";

export type Dialled = { readonly address: string; readonly port: number };

export type Upstream = {
    // The Host header of every request the upstream server received.
    readonly hosts: readonly string[];
    // Every address and port the proxy asked to connect to, in order.
    readonly dialled: readonly Dialled[];
    // A connect function for the proxy: it records the vetted address and port the proxy asks for,
    // then connects to this local server instead.
    connect(address: string, port: number): Socket;
    close(): Promise<void>;
};

export async function startUpstream(): Promise<Upstream> {
    const hosts: string[] = [];
    const dialled: Dialled[] = [];
    const server = createServer((incoming, response) => {
        hosts.push(incoming.headers.host ?? "");
        response.writeHead(200, { "content-type": "text/plain" }).end(UPSTREAM_BODY);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        hosts,
        dialled,
        connect(address, requestedPort) {
            dialled.push({ address, port: requestedPort });
            return connect(port, "127.0.0.1");
        },
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
