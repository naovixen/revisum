// How a service's answer reaches the client through the egress proxy. An answer that stops short of
// the length it declared must end the client's connection promptly, whether it was being piped or
// held back for a rewrite: nothing else tells the client the body was cut. A rewrite works on bytes,
// so a body that isn't UTF-8 keeps every byte but the found ones, and a held-back body has a limit.
import assert from "node:assert/strict";
import { createServer as createTcpServer, connect, type AddressInfo, type Server } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type EgressProxy, type RewriteRule } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    sizedAnswer,
    startLocalService,
    type Answer,
    type LocalService,
} from "../support/LocalService.ts";
import { exchangeWithProxy, plainRequestText } from "../support/GetThroughProxy.ts";
import { fakeResolver } from "../examples/DeclaredService.ts";

const SERVICE_ORIGIN = "http://service.test";
const SERVICE_ADDRESS = "93.184.215.14";
const THIRTY_TWO_MEBIBYTES = 32 * 1024 * 1024;
const PROMPTLY_MILLISECONDS = 2000;
const CUT_ANSWER =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\nhello";
const FIND_TEXT = "change-me";
const REPLACE_TEXT = "changed";
const REWRITE_RULE: RewriteRule = {
    origin: SERVICE_ORIGIN,
    rewrite: { name: "body-changed", find: FIND_TEXT, replace: REPLACE_TEXT },
};

const DELIVERIES = [
    { title: "a piped answer", rewrites: [], isHeldBack: false },
    { title: "an answer held back for a rewrite", rewrites: [REWRITE_RULE], isHeldBack: true },
] as const;

type RawService = { readonly port: number; close(): Promise<void> };

// Sends `answer` to the first bytes it receives, then its FIN.
async function startRawService(answer: string): Promise<RawService> {
    const server: Server = createTcpServer((socket) => {
        socket.on("error", () => undefined);
        socket.once("data", () => {
            socket.end(answer);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        port,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
            }),
    };
}

const bodyOf = (answer: string): string => answer.slice(answer.indexOf("\r\n\r\n") + 4);

const rulesFor = (rewrites: readonly RewriteRule[]): unknown => ({
    allowedOrigins: [SERVICE_ORIGIN],
    privateOrigins: [],
    rewrites,
});

describe("Using the egress proxy", () => {
    for (const { title, rewrites, isHeldBack } of DELIVERIES) {
        describe(`given ${title} that a service cuts short of its declared length`, () => {
            let service: RawService;
            let proxy: EgressProxy;

            beforeEach(async () => {
                service = await startRawService(CUT_ANSWER);
                proxy = await startedProxyServer(rulesFor(rewrites), {
                    resolve: fakeResolver({ "service.test": [SERVICE_ADDRESS] }).resolve,
                    connect: () => connect(service.port, "127.0.0.1"),
                });
            });
            afterEach(async () => {
                await proxy.close();
                await service.close();
            });

            describe("when the client asks for it", () => {
                test("then it should close the client's connection promptly, so the cut is seen", async () => {
                    const received = await exchangeWithProxy(
                        proxy.url,
                        plainRequestText(SERVICE_ORIGIN),
                        PROMPTLY_MILLISECONDS,
                    );
                    assert.ok(bodyOf(received).length < 100, received);
                    if (isHeldBack) {
                        assert.doesNotMatch(received, /^HTTP\/1\.1 200/);
                    }
                });
            });
        });
    }

    describe("given a rewrite and a body whose bytes are not UTF-8", () => {
        const notUtf8 = (middle: string): Buffer =>
            Buffer.concat([
                Buffer.from([0xff, 0xfe]),
                Buffer.from(middle),
                Buffer.from([0x80, 0x81]),
            ]);
        let service: LocalService;
        let proxy: EgressProxy;

        beforeEach(async () => {
            const answer: Answer = (received, response) => {
                response
                    .writeHead(200, { "content-type": "application/octet-stream" })
                    .end(notUtf8(FIND_TEXT));
            };
            service = await startLocalService(answer);
            proxy = await startedProxyServer(rulesFor([REWRITE_RULE]), {
                resolve: fakeResolver({ "service.test": [SERVICE_ADDRESS] }).resolve,
                connect: (address, port) => service.connect(address, port),
            });
        });
        afterEach(async () => {
            await proxy.close();
            await service.close();
        });

        describe("when the client asks for it", () => {
            test("then it should replace only the found bytes and keep every other byte", async () => {
                const received = await exchangeWithProxy(
                    proxy.url,
                    plainRequestText(SERVICE_ORIGIN),
                );
                assert.equal(bodyOf(received), notUtf8(REPLACE_TEXT).toString("latin1"));
            });
        });
    });

    describe("given a rewrite and a service that sends a very long body in chunks", () => {
        let service: LocalService;
        let proxy: EgressProxy;

        beforeEach(async () => {
            service = await startLocalService();
            proxy = await startedProxyServer(rulesFor([REWRITE_RULE]), {
                resolve: fakeResolver({ "service.test": [SERVICE_ADDRESS] }).resolve,
                connect: (address, port) => service.connect(address, port),
            });
        });
        afterEach(async () => {
            await proxy.close();
            await service.close();
        });

        describe("when the body is one byte longer than 32 MiB", () => {
            test("then it should answer 502 rather than hold it all back", async () => {
                service.answerWith(sizedAnswer(THIRTY_TWO_MEBIBYTES + 1, true));
                const received = await exchangeWithProxy(
                    proxy.url,
                    plainRequestText(SERVICE_ORIGIN),
                );
                assert.match(received, /^HTTP\/1\.1 502/);
            });
        });

        describe("when the body is exactly 32 MiB", () => {
            test("then it should deliver the whole body", async () => {
                service.answerWith(sizedAnswer(THIRTY_TWO_MEBIBYTES, true));
                const received = await exchangeWithProxy(
                    proxy.url,
                    plainRequestText(SERVICE_ORIGIN),
                );
                assert.match(received, /^HTTP\/1\.1 200/);
                assert.equal(bodyOf(received).length, THIRTY_TWO_MEBIBYTES);
            });
        });
    });
});
