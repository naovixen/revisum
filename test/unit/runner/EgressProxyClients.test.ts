// How the egress proxy answers depends on who asks. A service call reads the answer, so it gets a
// status and, on a plain request, a mark that says whose answer it is. A browser would show an answer
// to the page as content, and a rendered 502 would pass for a page that loaded, so a browser gets the
// socket closed with nothing on it. Every request here goes over a raw socket, which is the only way to
// see that nothing was sent. A name that doesn't resolve and an origin nobody listens on are not
// refusals, so neither counts as blocked.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import { startProxyServer, type EgressProxy, type ProxyRules } from "@revisum/runner";
import {
    connectThroughProxy,
    exchangeWithProxy,
    getThroughProxy,
    plainRequestText,
    tunnelRequestText,
} from "./proxy-requests.ts";
import { fakeResolver } from "./runner-examples.ts";

const APP_BODY = "reached the app";
const IDLE_LIMIT_MILLISECONDS = 130_000;
// The service caller's own limit on one call, which it keeps to itself.
const LONGEST_SERVICE_CALL_MILLISECONDS = 120_000;
const BROWSER_CLIENT = { client: "browser" } as const;
const SERVICE_CLIENT = { client: "service" } as const;

const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
};

const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });

// A port nobody is listening on now.
async function deadPort(): Promise<number> {
    const server = createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
}

type Attempt = {
    // Finishes the sentence "and".
    readonly title: string;
    readonly request: (proxyUrl: string) => Promise<string>;
    // What the decision is recorded under.
    readonly seenAs: string;
    // What a service client is told.
    readonly serviceAnswer: RegExp;
    readonly isBlocked: boolean;
};

const BLOCKED_MARK = /x-egress-decision: blocked/i;
const UNREACHABLE_MARK = /x-egress-decision: unreachable/i;

const DEAD_PORT = await deadPort();
const deadOrigin = `http://127.0.0.1:${DEAD_PORT}`;
const deadAuthority = `127.0.0.1:${DEAD_PORT}`;

let app: Server;
let appPort: number;
let browserProxy: EgressProxy;
let serviceProxy: EgressProxy;

const rules = (): ProxyRules => ({
    allowedOrigins: [
        `http://127.0.0.1:${appPort}`,
        deadOrigin,
        "http://gone.test",
        "https://gone.test",
        "http://no-address.test",
        "http://metadata.test",
    ],
    privateOrigins: [`http://127.0.0.1:${appPort}`, deadOrigin],
    rewrites: [],
});

const resolver = () =>
    fakeResolver({ "no-address.test": [], "metadata.test": ["169.254.169.254"] }).resolve;

const attempts = (): readonly Attempt[] => [
    {
        title: "a plain request to an undeclared origin",
        request: (url) => exchangeWithProxy(url, plainRequestText("http://undeclared.test")),
        seenAs: "http://undeclared.test",
        serviceAnswer: /^HTTP\/1\.1 403/,
        isBlocked: true,
    },
    {
        title: "a tunnel to an undeclared origin",
        request: (url) => exchangeWithProxy(url, tunnelRequestText("undeclared.test:443")),
        seenAs: "undeclared.test:443",
        serviceAnswer: /^HTTP\/1\.1 403/,
        isBlocked: true,
    },
    {
        title: "a plain request in a scheme the proxy does not carry",
        request: (url) => exchangeWithProxy(url, plainRequestText("ftp://files.test")),
        seenAs: "ftp://files.test",
        serviceAnswer: /^HTTP\/1\.1 400/,
        isBlocked: true,
    },
    {
        title: "a plain request to a declared name that resolves to a metadata address",
        request: (url) => exchangeWithProxy(url, plainRequestText("http://metadata.test")),
        seenAs: "http://metadata.test",
        serviceAnswer: /^HTTP\/1\.1 403/,
        isBlocked: true,
    },
    {
        title: "a plain request to a declared origin nobody listens on",
        request: (url) => exchangeWithProxy(url, plainRequestText(deadOrigin)),
        seenAs: deadOrigin,
        serviceAnswer: /^HTTP\/1\.1 502/,
        isBlocked: false,
    },
    {
        title: "a tunnel to a declared origin nobody listens on",
        request: (url) => exchangeWithProxy(url, tunnelRequestText(deadAuthority)),
        seenAs: deadAuthority,
        serviceAnswer: /^HTTP\/1\.1 502/,
        isBlocked: false,
    },
    {
        title: "a plain request to a declared name that does not resolve",
        request: (url) => exchangeWithProxy(url, plainRequestText("http://gone.test")),
        seenAs: "http://gone.test",
        serviceAnswer: /^HTTP\/1\.1 502/,
        isBlocked: false,
    },
    {
        title: "a tunnel to a declared name that does not resolve",
        request: (url) => exchangeWithProxy(url, tunnelRequestText("gone.test:443")),
        seenAs: "gone.test:443",
        serviceAnswer: /^HTTP\/1\.1 502/,
        isBlocked: false,
    },
    {
        title: "a plain request to a declared name that resolves to no address",
        request: (url) => exchangeWithProxy(url, plainRequestText("http://no-address.test")),
        seenAs: "http://no-address.test",
        serviceAnswer: /^HTTP\/1\.1 502/,
        isBlocked: false,
    },
];

const blockedDecisions = (proxy: EgressProxy, seenAs: string): readonly unknown[] =>
    proxy.decisions().filter((entry) => entry.origin === seenAs && entry.decision === "blocked");

before(async () => {
    app = createServer((incoming, response) => {
        incoming.resume();
        response.writeHead(200, { "content-type": "text/plain" }).end(APP_BODY);
    });
    appPort = await listen(app);
    browserProxy = await startProxyServer(rules(), { ...BROWSER_CLIENT, resolve: resolver() });
    serviceProxy = await startProxyServer(rules(), { ...SERVICE_CLIENT, resolve: resolver() });
});
after(async () => {
    await browserProxy.close();
    await serviceProxy.close();
    await closeServer(app);
});

describe("Using the egress proxy", () => {
    describe("given a browser as its client", () => {
        for (const { title, request, seenAs, isBlocked } of attempts()) {
            describe(`and ${title}`, () => {
                describe("when the proxy gets it", () => {
                    let received: string;
                    before(async () => {
                        received = await request(browserProxy.url);
                    });

                    test("then it should close the socket without answering", () => {
                        assert.equal(received, "");
                    });

                    test(`then it should record ${isBlocked ? "a block" : "no block"}`, () => {
                        assert.equal(
                            blockedDecisions(browserProxy, seenAs).length,
                            isBlocked ? 1 : 0,
                            JSON.stringify(browserProxy.decisions()),
                        );
                    });
                });
            });
        }

        describe("and a declared origin that answers", () => {
            describe("when a page asks for it plainly", () => {
                test("then it should pass the answer on, so a closed socket means something", async () => {
                    const answer = await getThroughProxy(
                        browserProxy.url,
                        `http://127.0.0.1:${appPort}/`,
                    );
                    assert.deepEqual(answer, { status: 200, body: APP_BODY });
                });
            });

            describe("when a page asks for a tunnel to it", () => {
                test("then it should open the tunnel", async () => {
                    assert.equal(
                        await connectThroughProxy(browserProxy.url, `127.0.0.1:${appPort}`),
                        200,
                    );
                });
            });
        });
    });

    describe("given a service as its client", () => {
        for (const { title, request, seenAs, serviceAnswer, isBlocked } of attempts()) {
            describe(`and ${title}`, () => {
                describe("when the proxy gets it", () => {
                    let received: string;
                    before(async () => {
                        received = await request(serviceProxy.url);
                    });

                    test(`then it should answer with ${serviceAnswer.source.slice(-3)}`, () => {
                        assert.match(received, serviceAnswer);
                    });

                    if (title.startsWith("a plain request")) {
                        test(`then it should mark the answer as ${isBlocked ? "blocked" : "unreachable"}`, () => {
                            assert.match(received, isBlocked ? BLOCKED_MARK : UNREACHABLE_MARK);
                        });
                    }

                    test(`then it should record ${isBlocked ? "a block" : "no block"}`, () => {
                        assert.equal(
                            blockedDecisions(serviceProxy, seenAs).length,
                            isBlocked ? 1 : 0,
                            JSON.stringify(serviceProxy.decisions()),
                        );
                    });
                });
            });
        }
    });

    describe("given a declared origin that is reached with a plain request", () => {
        const idleLimitWhileAnswering = async (
            clientOption: typeof BROWSER_CLIENT | typeof SERVICE_CLIENT,
        ): Promise<number> => {
            let upstream: Socket | undefined;
            let limit = -1;
            const slowApp = createServer((incoming, response) => {
                incoming.resume();
                limit = upstream?.timeout ?? 0;
                response.end(APP_BODY);
            });
            const port = await listen(slowApp);
            const origin = `http://127.0.0.1:${port}`;
            const proxy = await startProxyServer(
                { allowedOrigins: [origin], privateOrigins: [origin], rewrites: [] },
                {
                    ...clientOption,
                    connect: (address, dialledPort) => {
                        upstream = connect({ host: address, port: dialledPort });
                        return upstream;
                    },
                },
            );
            try {
                await getThroughProxy(proxy.url, `${origin}/`);
            } finally {
                await proxy.close();
                await closeServer(slowApp);
            }
            return limit;
        };

        describe("when a browser is the client and the app is answering", () => {
            test("then it should hold no idle limit on the connection", async () => {
                assert.equal(await idleLimitWhileAnswering(BROWSER_CLIENT), 0);
            });
        });

        describe("when a service is the client and the app is answering", () => {
            test("then it should hold the idle limit on the connection", async () => {
                assert.equal(
                    await idleLimitWhileAnswering(SERVICE_CLIENT),
                    IDLE_LIMIT_MILLISECONDS,
                );
            });

            test("then it should wait longer than the service caller's longest call, so the caller's timeout decides", async () => {
                const limit = await idleLimitWhileAnswering(SERVICE_CLIENT);
                assert.ok(limit > LONGEST_SERVICE_CALL_MILLISECONDS, `the idle limit is ${limit}`);
            });
        });
    });
});
