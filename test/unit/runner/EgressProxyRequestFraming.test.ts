// What the egress proxy forwards of a request. A request with a body keeps its framing whatever its
// method: a body sent to a service with no framing would be read as the next request on the
// connection, which is how a request is smuggled past the proxy's checks. Headers the client or the
// service named in Connection describe that one connection, so they stop at the proxy.
import assert from "node:assert/strict";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import { emptyAnswer, startLocalService, type LocalService } from "./local-service.ts";
import { exchangeWithProxy, plainRequestText } from "./proxy-requests.ts";
import { fakeResolver } from "./runner-examples.ts";

const SERVICE_ORIGIN = "http://service.test";
const SMUGGLED = "GET /smuggled HTTP/1.1\r\nHost: service.test\r\n\r\n";
const METHODS_WITHOUT_A_DEFAULT_BODY = ["DELETE", "GET", "OPTIONS"] as const;
const CONNECTION_NAMED_HEADER = "x-hop-token";
const KEPT_HEADER = "x-kept";

const rules = (): unknown => ({
    allowedOrigins: [SERVICE_ORIGIN],
    privateOrigins: [],
    rewrites: [],
});
const resolver = () => fakeResolver({ "service.test": ["93.184.215.14"] }).resolve;

// One request carrying `body` in one chunk, as the client's own framing.
const chunkedRequestText = (method: string, body: string): string =>
    `${method} ${SERVICE_ORIGIN}/orders HTTP/1.1\r\nHost: service.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`;

// Every byte the proxy sent a service that replies once it has seen `until`.
async function bytesSentToRawService(
    until: string,
    proxyFor: (port: number) => Promise<EgressProxy>,
    send: (proxy: EgressProxy) => Promise<string>,
): Promise<string> {
    let received = "";
    const server: Server = createTcpServer((socket) => {
        socket.on("error", () => undefined);
        socket.on("data", (chunk: Buffer) => {
            received += chunk.toString("latin1");
            if (received.includes(until)) {
                socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const proxy = await proxyFor(port);
    try {
        await send(proxy);
        return received;
    } finally {
        await proxy.close();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }
}

describe("Using the egress proxy", () => {
    describe("given a service that keeps what it is sent", () => {
        let service: LocalService;
        let proxy: EgressProxy;

        beforeEach(async () => {
            service = await startLocalService(emptyAnswer(200));
            proxy = await startedProxyServer(rules(), {
                resolve: resolver(),
                connect: (address, port) => service.connect(address, port),
            });
        });
        afterEach(async () => {
            await proxy.close();
            await service.close();
        });

        for (const method of METHODS_WITHOUT_A_DEFAULT_BODY) {
            describe(`and a ${method} request with a chunked body holding another request`, () => {
                describe("when the proxy forwards it", () => {
                    test("then it should arrive as one request with that body", async () => {
                        await exchangeWithProxy(proxy.url, chunkedRequestText(method, SMUGGLED));
                        assert.deepEqual(
                            service.received.map(({ method: sent, path, body }) => ({
                                sent,
                                path,
                                body,
                            })),
                            [{ sent: method, path: "/orders", body: SMUGGLED }],
                        );
                    });
                });
            });
        }

        describe("and a POST request with a chunked body", () => {
            describe("when the proxy forwards it", () => {
                test("then it should arrive whole", async () => {
                    await exchangeWithProxy(proxy.url, chunkedRequestText("POST", "an order"));
                    assert.equal(service.received[0]?.body, "an order");
                });
            });
        });

        describe("and a GET request with no body", () => {
            describe("when the proxy forwards it", () => {
                test("then it should not add any framing", async () => {
                    await exchangeWithProxy(proxy.url, plainRequestText(SERVICE_ORIGIN));
                    assert.equal(service.received[0]?.headers["transfer-encoding"], undefined);
                });
            });
        });

        describe("and a request naming one of its headers in Connection", () => {
            describe("when the proxy forwards it", () => {
                test("then it should drop the named header and keep the others", async () => {
                    await exchangeWithProxy(
                        proxy.url,
                        `GET ${SERVICE_ORIGIN}/ HTTP/1.1\r\nHost: service.test\r\nConnection: close, X-Hop-Token\r\nX-Hop-Token: a-secret\r\nX-Kept: yes\r\n\r\n`,
                    );
                    const headers = service.received[0]?.headers;
                    assert.equal(headers?.[CONNECTION_NAMED_HEADER], undefined);
                    assert.equal(headers?.[KEPT_HEADER], "yes");
                });
            });
        });

        describe("and a service naming one of its answer's headers in Connection", () => {
            describe("when the proxy passes the answer on", () => {
                test("then it should drop the named header and keep the others", async () => {
                    service.answerWith((received, response) => {
                        response
                            .writeHead(200, {
                                Connection: "close, X-Hop-Token",
                                "X-Hop-Token": "a-secret",
                                "X-Kept": "yes",
                            })
                            .end();
                    });
                    const received = await exchangeWithProxy(
                        proxy.url,
                        plainRequestText(SERVICE_ORIGIN),
                    );
                    assert.doesNotMatch(received, /x-hop-token:/i);
                    assert.match(received, /x-kept: yes/i);
                });
            });
        });
    });

    describe("given a service that shows the bytes it was sent", () => {
        for (const method of METHODS_WITHOUT_A_DEFAULT_BODY) {
            describe(`and a ${method} request with a chunked body holding another request`, () => {
                describe("when the proxy forwards it", () => {
                    test("then it should send the service a framed body, never the other request bare", async () => {
                        const sent = await bytesSentToRawService(
                            "GET /smuggled",
                            (port) =>
                                startedProxyServer(rules(), {
                                    resolve: resolver(),
                                    connect: () => connect(port, "127.0.0.1"),
                                }),
                            (proxy) =>
                                exchangeWithProxy(
                                    proxy.url,
                                    chunkedRequestText(method, SMUGGLED),
                                    2000,
                                ),
                        );
                        const headEnd = sent.indexOf("\r\n\r\n");
                        assert.match(
                            sent.slice(0, headEnd),
                            /transfer-encoding: chunked|content-length:/i,
                        );
                        assert.doesNotMatch(sent.slice(headEnd + 4), /^GET \/smuggled/);
                    });
                });
            });
        }
    });
});
