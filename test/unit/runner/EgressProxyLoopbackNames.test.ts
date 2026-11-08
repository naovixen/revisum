// A loopback name needs no lookup, and a declared app may listen on only one of a name's addresses.
// `localhost` resolves to ::1 first on Windows, so a proxy that tries only the first address answers
// 502 for an app bound to 127.0.0.1. The resolver here throws on any name it wasn't told about, and
// these apps are real servers bound to 127.0.0.1 alone, so a pass means the proxy really tried each
// address in turn. A name that merely contains "localhost" is the counter-example: it is looked up.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    connectThroughProxy,
    getThroughProxy,
    startUpstream,
    type Upstream,
} from "./proxy-requests.ts";
import { fakeResolver, type FakeResolver } from "./runner-examples.ts";

const APP_BODY = "reached the app";
const PUBLIC_ADDRESS = "93.184.215.14";
const CLIENTS = ["service", "browser"] as const;
const SERVICE_CLIENT = { client: "service" } as const;

const NAME_ANSWERS = {
    "ipv6-first.test": ["::1", "127.0.0.1"],
    "ipv4-first.test": ["127.0.0.1", "::1"],
    "app.localhost.attacker.test": [PUBLIC_ADDRESS],
    notlocalhost: [PUBLIC_ADDRESS],
};

let app: Server;
let appPort: number;
let deadPort: number;
const appHits: string[] = [];

const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });

before(async () => {
    app = createServer((incoming, response) => {
        appHits.push(incoming.headers.host ?? "");
        response.writeHead(200, { "content-type": "text/plain" }).end(APP_BODY);
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    appPort = (app.address() as AddressInfo).port;
    const closing = createServer();
    await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
    deadPort = (closing.address() as AddressInfo).port;
    await closeServer(closing);
});
after(async () => {
    await closeServer(app);
});

type Proxied = {
    readonly proxy: EgressProxy;
    readonly resolver: FakeResolver;
    readonly dialled: readonly string[];
};

// A proxy on the real network, whose every declared name may reach a private address.
async function proxyDeclaring(
    origins: readonly string[],
    clientOption: { readonly client: (typeof CLIENTS)[number] },
): Promise<Proxied> {
    const resolver = fakeResolver(NAME_ANSWERS);
    const dialled: string[] = [];
    const rules = {
        allowedOrigins: origins,
        privateOrigins: origins,
        rewrites: [],
    };
    const proxy = await startedProxyServer(rules, {
        ...clientOption,
        resolve: resolver.resolve,
        connect: (address, port) => {
            dialled.push(address);
            return connect({ host: address, port });
        },
    });
    return { proxy, resolver, dialled };
}

describe("Using the egress proxy", () => {
    for (const client of CLIENTS) {
        for (const name of ["localhost", "app.localhost"]) {
            describe(`given ${name} declared, an app bound only to 127.0.0.1, and a ${client} as client`, () => {
                let proxied: Proxied;
                before(async () => {
                    proxied = await proxyDeclaring([`http://${name}:${appPort}`], { client });
                });
                after(async () => {
                    await proxied.proxy.close();
                });

                describe("when a plain request asks for it", () => {
                    test("then it should reach the app", async () => {
                        const answer = await getThroughProxy(
                            proxied.proxy.url,
                            `http://${name}:${appPort}/`,
                        );
                        assert.deepEqual(answer, { status: 200, body: APP_BODY });
                    });

                    test("then it should send the name it was asked for", () => {
                        assert.equal(appHits.at(-1), `${name}:${appPort}`);
                    });

                    test("then it should look nothing up", () => {
                        assert.deepEqual(proxied.resolver.asked, []);
                    });

                    test("then it should record the origin as allowed", () => {
                        assert.deepEqual(proxied.proxy.decisions(), [
                            { origin: `http://${name}:${appPort}`, decision: "allowed" },
                        ]);
                    });
                });
            });

            describe(`given ${name} declared on a port, and a ${client} as client asking for a tunnel`, () => {
                let proxied: Proxied;
                before(async () => {
                    proxied = await proxyDeclaring([`https://${name}:${appPort}`], { client });
                });
                after(async () => {
                    await proxied.proxy.close();
                });

                describe("when the tunnel opens", () => {
                    test("then it should connect to the app with no lookup", async () => {
                        assert.equal(
                            await connectThroughProxy(proxied.proxy.url, `${name}:${appPort}`),
                            200,
                        );
                        assert.deepEqual(proxied.resolver.asked, []);
                    });
                });
            });
        }
    }

    describe("given a sibling of a declared loopback name that is not declared", () => {
        let proxied: Proxied;
        let hitsBefore: number;
        before(async () => {
            proxied = await proxyDeclaring([`http://app.localhost:${appPort}`], SERVICE_CLIENT);
            hitsBefore = appHits.length;
        });
        after(async () => {
            await proxied.proxy.close();
        });

        describe("when a request asks for it", () => {
            test("then it should refuse it and connect to nothing", async () => {
                const answer = await getThroughProxy(
                    proxied.proxy.url,
                    `http://other.localhost:${appPort}/`,
                );
                assert.equal(answer.status, 403);
                assert.deepEqual(proxied.dialled, []);
                assert.equal(appHits.length, hitsBefore);
                assert.deepEqual(proxied.proxy.decisions(), [
                    { origin: `http://other.localhost:${appPort}`, decision: "blocked" },
                ]);
            });
        });
    });

    describe("given localhost declared, but not as a private origin", () => {
        let upstream: Upstream;
        let resolver: FakeResolver;
        let proxy: EgressProxy;
        before(async () => {
            upstream = await startUpstream();
            resolver = fakeResolver({});
            proxy = await startedProxyServer(
                { allowedOrigins: ["http://localhost"], privateOrigins: [], rewrites: [] },
                {
                    ...SERVICE_CLIENT,
                    resolve: resolver.resolve,
                    connect: (address, port) => upstream.connect(address, port),
                },
            );
        });
        after(async () => {
            await proxy.close();
            await upstream.close();
        });

        describe("when a service asks for it", () => {
            test("then it should refuse it, connect to nothing, and look nothing up", async () => {
                const answer = await getThroughProxy(proxy.url, "http://localhost/");
                assert.equal(answer.status, 403);
                assert.deepEqual(upstream.dialled, []);
                assert.deepEqual(resolver.asked, []);
                assert.deepEqual(proxy.decisions(), [
                    { origin: "http://localhost", decision: "blocked" },
                ]);
            });
        });
    });

    for (const name of ["app.localhost.attacker.test", "notlocalhost"]) {
        describe(`given the declared name ${name}, which only looks like a loopback name`, () => {
            let upstream: Upstream;
            let resolver: FakeResolver;
            let proxy: EgressProxy;
            before(async () => {
                upstream = await startUpstream();
                resolver = fakeResolver(NAME_ANSWERS);
                proxy = await startedProxyServer(
                    { allowedOrigins: [`http://${name}`], privateOrigins: [], rewrites: [] },
                    {
                        ...SERVICE_CLIENT,
                        resolve: resolver.resolve,
                        connect: (address, port) => upstream.connect(address, port),
                    },
                );
            });
            after(async () => {
                await proxy.close();
                await upstream.close();
            });

            describe("when a request asks for it", () => {
                test("then it should look the name up and connect to what it found", async () => {
                    const answer = await getThroughProxy(proxy.url, `http://${name}/`);
                    assert.equal(answer.status, 200);
                    assert.equal(resolver.lookupsOf(name), 1);
                    assert.deepEqual(upstream.dialled, [{ address: PUBLIC_ADDRESS, port: 80 }]);
                });
            });
        });
    }

    describe("given a declared name whose first address has nothing listening", () => {
        let proxied: Proxied;
        before(async () => {
            proxied = await proxyDeclaring(
                [`http://ipv6-first.test:${appPort}`, `https://ipv6-first.test:${appPort}`],
                SERVICE_CLIENT,
            );
        });
        after(async () => {
            await proxied.proxy.close();
        });

        describe("when a plain request asks for it", () => {
            test("then it should try each address in turn and reach the app", async () => {
                const answer = await getThroughProxy(
                    proxied.proxy.url,
                    `http://ipv6-first.test:${appPort}/`,
                );
                assert.deepEqual(answer, { status: 200, body: APP_BODY });
                assert.deepEqual(proxied.dialled, ["::1", "127.0.0.1"]);
                assert.equal(proxied.resolver.lookupsOf("ipv6-first.test"), 1);
            });
        });

        describe("when a tunnel asks for it", () => {
            test("then it should try each address in turn and open the tunnel", async () => {
                const dialledBefore = proxied.dialled.length;
                assert.equal(
                    await connectThroughProxy(proxied.proxy.url, `ipv6-first.test:${appPort}`),
                    200,
                );
                assert.deepEqual(proxied.dialled.slice(dialledBefore), ["::1", "127.0.0.1"]);
            });
        });
    });

    describe("given a declared name whose first address answers", () => {
        let proxied: Proxied;
        before(async () => {
            proxied = await proxyDeclaring([`http://ipv4-first.test:${appPort}`], SERVICE_CLIENT);
        });
        after(async () => {
            await proxied.proxy.close();
        });

        describe("when a plain request asks for it", () => {
            test("then it should stop at that address", async () => {
                const answer = await getThroughProxy(
                    proxied.proxy.url,
                    `http://ipv4-first.test:${appPort}/`,
                );
                assert.equal(answer.status, 200);
                assert.deepEqual(proxied.dialled, ["127.0.0.1"]);
            });
        });
    });

    describe("given a declared name with nothing listening on any of its addresses", () => {
        let proxied: Proxied;
        before(async () => {
            proxied = await proxyDeclaring([`http://ipv6-first.test:${deadPort}`], SERVICE_CLIENT);
        });
        after(async () => {
            await proxied.proxy.close();
        });

        describe("when a plain request asks for it", () => {
            test("then it should try them all and answer that the service did not answer", async () => {
                const answer = await getThroughProxy(
                    proxied.proxy.url,
                    `http://ipv6-first.test:${deadPort}/`,
                );
                assert.equal(answer.status, 502);
                assert.deepEqual(proxied.dialled, ["::1", "127.0.0.1"]);
            });
        });
    });
});
