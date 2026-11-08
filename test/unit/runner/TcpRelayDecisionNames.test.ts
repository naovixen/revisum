// A TCP relay's host is held bare, so a decision for an IPv6 relay is named once, in brackets, however
// the host was written where the proxy's container reads its rules.
import assert from "node:assert/strict";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { after, before, describe, test } from "node:test";
import { proxyRulesFromText, startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import { closedPort } from "./local-service.ts";
import { fakeResolver } from "./runner-examples.ts";

const WRITTEN_HOSTS = ["[::1]", "::1"] as const;

describe("Using the egress proxy", () => {
    let relayTarget: Server;
    let targetPort: number;

    before(async () => {
        relayTarget = createTcpServer((socket) => {
            socket.resume();
            socket.end();
        });
        await new Promise<void>((resolve) => relayTarget.listen(0, "127.0.0.1", resolve));
        targetPort = (relayTarget.address() as AddressInfo).port;
    });
    after(async () => {
        await new Promise<void>((resolve) => {
            relayTarget.close(() => resolve());
        });
    });

    for (const host of WRITTEN_HOSTS) {
        describe(`given a TCP relay whose host is written ${host}`, () => {
            describe("when a client connects to the relay", () => {
                test("then it should name the decision once in brackets", async () => {
                    const port = await closedPort();
                    const text = JSON.stringify({
                        allowedOrigins: [],
                        privateOrigins: [],
                        rewrites: [],
                        tcpRelays: [{ host, port, private: true }],
                    });
                    const proxy = await startedProxyServer(proxyRulesFromText(text), {
                        resolve: fakeResolver({}).resolve,
                        connect: () => connect(targetPort, "127.0.0.1"),
                    });
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const client = connect(port, "127.0.0.1");
                            client.on("error", reject);
                            client.on("close", () => {
                                resolve();
                            });
                            client.write("hello");
                        });
                        assert.deepEqual(proxy.decisions(), [
                            { origin: `[::1]:${port}`, decision: "allowed" },
                        ]);
                    } finally {
                        await proxy.close();
                    }
                });
            });
        });
    }
});
