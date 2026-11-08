// What the egress proxy keeps for whoever is running when it can't connect to a declared origin. It
// connects directly, so from any origin off this machine a failure may mean a dead origin or a machine
// that reaches the network only through a proxy, and the message names both. A connection to this
// machine never crosses a machine proxy, so there the message names only the first. The message stays
// out of the proxy's answers: isolated containers run the same code, and it would be false there.
// Each message is written out in full, and each case has a neighbour that gets the other outcome.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
    ProxyClient,
    type AddressConnector,
    type EgressProxy,
} from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    exchangeWithProxy,
    getThroughProxy,
    plainRequestText,
    startUpstream,
    tunnelRequestText,
    type Upstream,
    UPSTREAM_BODY,
} from "./proxy-requests.ts";
import { fakeResolver } from "./runner-examples.ts";

const PUBLIC_ADDRESS = "93.184.215.14";
const OTHER_PUBLIC_ADDRESS = "93.184.215.15";
const REFUSAL_REASON = "the connection was refused";
const NAME_ANSWERS = {
    "dead-public.test": [PUBLIC_ADDRESS],
    "other-dead-public.test": [OTHER_PUBLIC_ADDRESS],
    "two-addresses.test": [PUBLIC_ADDRESS, OTHER_PUBLIC_ADDRESS],
    "no-address.test": [],
    "all-loopback.test": ["127.0.0.1", "::1"],
    "loopback-and-lan.test": ["127.0.0.1", "192.168.1.10"],
};
const RULES = {
    allowedOrigins: [
        "http://dead-public.test",
        "https://dead-public.test",
        "http://other-dead-public.test",
        "http://two-addresses.test",
        `http://${PUBLIC_ADDRESS}`,
        "http://gone.test",
        "https://gone.test",
        "http://no-address.test",
        "http://127.0.0.1:8080",
        "https://127.0.0.1:8443",
        "http://[::1]:8080",
        "http://localhost:8080",
        "http://all-loopback.test",
        "http://loopback-and-lan.test",
    ],
    privateOrigins: [
        "http://127.0.0.1:8080",
        "https://127.0.0.1:8443",
        "http://[::1]:8080",
        "http://localhost:8080",
        "http://all-loopback.test",
        "http://loopback-and-lan.test",
    ],
    rewrites: [],
};
const WORDING_OF_EITHER_MESSAGE = /could not connect|nothing answered|machine proxy/i;

const eitherCauseMessage = (origin: string, reason: string): string =>
    `Could not connect to ${origin} (${reason}). Either nothing answers there, or this machine reaches the network only through a proxy, and a machine proxy isn't supported yet.`;

const nothingAnsweredMessage = (origin: string, reason: string): string =>
    `Nothing answered at ${origin} (${reason}).`;

// An attempt that fails the same way on every machine and never touches the network. The socket emits
// its error once the proxy is listening for it.
const refuseEveryConnection: AddressConnector = () =>
    new Socket().destroy(new Error(REFUSAL_REASON));

type FailedAttempt = {
    // Finishes the sentence "and".
    readonly title: string;
    readonly requestText: string;
    readonly origin: string;
    readonly message: string;
};

const FAILED_ATTEMPTS: readonly FailedAttempt[] = [
    {
        title: "a plain request to a dead declared name with a public address",
        requestText: plainRequestText("http://dead-public.test"),
        origin: "http://dead-public.test",
        message: eitherCauseMessage("http://dead-public.test", REFUSAL_REASON),
    },
    {
        title: "a tunnel to a dead declared name with a public address",
        requestText: tunnelRequestText("dead-public.test:443"),
        origin: "dead-public.test:443",
        message: eitherCauseMessage("dead-public.test:443", REFUSAL_REASON),
    },
    {
        title: "a plain request to a dead declared public address",
        requestText: plainRequestText(`http://${PUBLIC_ADDRESS}`),
        origin: `http://${PUBLIC_ADDRESS}`,
        message: eitherCauseMessage(`http://${PUBLIC_ADDRESS}`, REFUSAL_REASON),
    },
    {
        title: "a plain request to a declared name that does not resolve",
        requestText: plainRequestText("http://gone.test"),
        origin: "http://gone.test",
        message: eitherCauseMessage(
            "http://gone.test",
            "the fake resolver has no answer for gone.test",
        ),
    },
    {
        title: "a tunnel to a declared name that does not resolve",
        requestText: tunnelRequestText("gone.test:443"),
        origin: "gone.test:443",
        message: eitherCauseMessage(
            "gone.test:443",
            "the fake resolver has no answer for gone.test",
        ),
    },
    {
        title: "a plain request to a declared name that resolves to no address",
        requestText: plainRequestText("http://no-address.test"),
        origin: "http://no-address.test",
        message: eitherCauseMessage(
            "http://no-address.test",
            "no-address.test resolved to no address",
        ),
    },
    {
        title: "a plain request to a dead name with a loopback and a private address",
        requestText: plainRequestText("http://loopback-and-lan.test"),
        origin: "http://loopback-and-lan.test",
        message: eitherCauseMessage("http://loopback-and-lan.test", REFUSAL_REASON),
    },
    {
        title: "a plain request to a dead IPv4 loopback address",
        requestText: plainRequestText("http://127.0.0.1:8080"),
        origin: "http://127.0.0.1:8080",
        message: nothingAnsweredMessage("http://127.0.0.1:8080", REFUSAL_REASON),
    },
    {
        title: "a tunnel to a dead IPv4 loopback address",
        requestText: tunnelRequestText("127.0.0.1:8443"),
        origin: "127.0.0.1:8443",
        message: nothingAnsweredMessage("127.0.0.1:8443", REFUSAL_REASON),
    },
    {
        title: "a plain request to a dead IPv6 loopback address",
        requestText: plainRequestText("http://[::1]:8080"),
        origin: "http://[::1]:8080",
        message: nothingAnsweredMessage("http://[::1]:8080", REFUSAL_REASON),
    },
    {
        title: "a plain request to localhost with nothing listening",
        requestText: plainRequestText("http://localhost:8080"),
        origin: "http://localhost:8080",
        message: nothingAnsweredMessage("http://localhost:8080", REFUSAL_REASON),
    },
    {
        title: "a plain request to a dead name whose addresses are all loopback",
        requestText: plainRequestText("http://all-loopback.test"),
        origin: "http://all-loopback.test",
        message: nothingAnsweredMessage("http://all-loopback.test", REFUSAL_REASON),
    },
];

const startProxy = (client: ProxyClient, connect: AddressConnector): Promise<EgressProxy> =>
    startedProxyServer(RULES, { client, connect, resolve: fakeResolver(NAME_ANSWERS).resolve });

// A port nobody is listening on now.
async function deadPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe("Using the egress proxy", () => {
    for (const client of Object.values(ProxyClient)) {
        describe(`given a ${client} as its client and connections that all fail`, () => {
            let proxy: EgressProxy;
            beforeEach(async () => {
                proxy = await startProxy(client, refuseEveryConnection);
            });
            afterEach(async () => {
                await proxy.close();
            });

            for (const { title, requestText, origin, message } of FAILED_ATTEMPTS) {
                describe(`and ${title}`, () => {
                    describe("when the proxy gets it", () => {
                        test("then it should list the origin once with its message", async () => {
                            await exchangeWithProxy(proxy.url, requestText);
                            assert.deepEqual(proxy.connectionFailures(), [{ origin, message }]);
                        });
                    });
                });
            }

            describe("and a dead origin that is asked for three times", () => {
                describe("when the proxy gets each request", () => {
                    test("then it should list the origin once", async () => {
                        const requestText = plainRequestText("http://dead-public.test");
                        await exchangeWithProxy(proxy.url, requestText);
                        await exchangeWithProxy(proxy.url, requestText);
                        await exchangeWithProxy(proxy.url, requestText);
                        assert.deepEqual(proxy.connectionFailures(), [
                            {
                                origin: "http://dead-public.test",
                                message: eitherCauseMessage(
                                    "http://dead-public.test",
                                    REFUSAL_REASON,
                                ),
                            },
                        ]);
                    });
                });
            });

            describe("and two different dead origins", () => {
                describe("when the proxy gets a request for each", () => {
                    test("then it should list each of them, in the order they failed", async () => {
                        await exchangeWithProxy(
                            proxy.url,
                            plainRequestText("http://dead-public.test"),
                        );
                        await exchangeWithProxy(
                            proxy.url,
                            plainRequestText("http://other-dead-public.test"),
                        );
                        assert.deepEqual(
                            proxy.connectionFailures().map((failure) => failure.origin),
                            ["http://dead-public.test", "http://other-dead-public.test"],
                        );
                    });
                });
            });

            describe("and an origin that is not declared", () => {
                describe("when the proxy refuses it", () => {
                    test("then it should list nothing, because it tried no connection", async () => {
                        await exchangeWithProxy(
                            proxy.url,
                            plainRequestText("http://undeclared.test"),
                        );
                        assert.deepEqual(proxy.decisions(), [
                            { origin: "http://undeclared.test", decision: "blocked" },
                        ]);
                        assert.deepEqual(proxy.connectionFailures(), []);
                    });
                });
            });
        });

        describe(`given a ${client} as its client and an origin that answers`, () => {
            let upstream: Upstream;
            beforeEach(async () => {
                upstream = await startUpstream();
            });
            afterEach(async () => {
                await upstream.close();
            });

            const answerAndFailures = async (
                connect: AddressConnector,
            ): Promise<{ readonly body: string; readonly failures: readonly unknown[] }> => {
                const proxy = await startProxy(client, connect);
                try {
                    const { body } = await getThroughProxy(proxy.url, "http://two-addresses.test/");
                    return { body, failures: proxy.connectionFailures() };
                } finally {
                    await proxy.close();
                }
            };

            describe("when its first address accepts the connection", () => {
                test("then it should list nothing", async () => {
                    const outcome = await answerAndFailures((address, port) =>
                        upstream.connect(address, port),
                    );
                    assert.deepEqual(outcome, { body: UPSTREAM_BODY, failures: [] });
                });
            });

            describe("when only its second address accepts the connection", () => {
                test("then it should list nothing, because it did connect", async () => {
                    const outcome = await answerAndFailures((address, port) =>
                        address === PUBLIC_ADDRESS
                            ? refuseEveryConnection(address, port)
                            : upstream.connect(address, port),
                    );
                    assert.deepEqual(outcome, { body: UPSTREAM_BODY, failures: [] });
                    assert.deepEqual(upstream.dialled, [
                        { address: OTHER_PUBLIC_ADDRESS, port: 80 },
                    ]);
                });
            });
        });

        describe(`given a ${client} as its client and a real dead port on this machine`, () => {
            describe("when a plain request asks for it", () => {
                test("then it should give the operating system's reason in the shorter message", async () => {
                    const port = await deadPort();
                    const origin = `http://127.0.0.1:${port}`;
                    const proxy = await startedProxyServer(
                        { allowedOrigins: [origin], privateOrigins: [origin], rewrites: [] },
                        { client },
                    );
                    try {
                        await exchangeWithProxy(proxy.url, plainRequestText(origin));
                        assert.deepEqual(proxy.connectionFailures(), [
                            {
                                origin,
                                message: nothingAnsweredMessage(
                                    origin,
                                    `connect ECONNREFUSED 127.0.0.1:${port}`,
                                ),
                            },
                        ]);
                    } finally {
                        await proxy.close();
                    }
                });
            });
        });
    }

    describe("given a service as its client, which reads the proxy's answers", () => {
        let proxy: EgressProxy;
        beforeEach(async () => {
            proxy = await startProxy(ProxyClient.Service, refuseEveryConnection);
        });
        afterEach(async () => {
            await proxy.close();
        });

        for (const { title, requestText, message } of FAILED_ATTEMPTS) {
            describe(`and ${title}`, () => {
                describe("when the proxy gets it", () => {
                    test("then it should answer 502 and keep the message out of the answer", async () => {
                        const received = await exchangeWithProxy(proxy.url, requestText);
                        assert.match(received, /^HTTP\/1\.1 502/);
                        assert.match(message, WORDING_OF_EITHER_MESSAGE);
                        assert.doesNotMatch(received, WORDING_OF_EITHER_MESSAGE);
                    });
                });
            });
        }
    });
});
