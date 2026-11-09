// Starting and closing the egress proxy. A proxy that can't listen on any of its ports is a failed
// start, with nothing left listening behind it: a caller gets a failed outcome naming the listener,
// never a rejection, and every port it took is free again. A listener's close failure is reported
// rather than lost, closing waits for every listener, and a second close is safe. Once listening, a
// listener's error, such as an accept failure, is reported and leaves the proxy serving. So does a
// listener handed the proxy's decisions throwing, which must never end the process.
import assert from "node:assert/strict";
import { Server as HttpServer } from "node:http";
import { Server as NetServer, createServer as createTcpServer } from "node:net";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";
import { startProxyServer, type EgressProxy } from "@revisum/runner";
import { parsedProxyRules, startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import { closedPort } from "../support/LocalService.ts";
import { connectThroughProxy, getThroughProxy } from "../support/GetThroughProxy.ts";
import { fakeResolver } from "../examples/DeclaredService.ts";

const RELAY_HOST = "database.test";
const LISTEN_FAILED_CODE = "listen-failed";
const ADDRESS_IN_USE = /EADDRINUSE/;

type Occupier = { readonly port: number; close(): Promise<void> };

async function occupiedPort(): Promise<Occupier> {
    const server = createTcpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    return {
        port: address.port,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
            }),
    };
}

// Whether a port can be listened on right now.
async function isFree(port: number): Promise<boolean> {
    const server = createTcpServer();
    return new Promise((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
            server.close(() => resolve(true));
        });
    });
}

const relayOn = (port: number): unknown => ({ host: RELAY_HOST, port, private: true });

const rulesWithRelays = (relayPorts: readonly number[]): unknown => ({
    allowedOrigins: [],
    privateOrigins: [],
    rewrites: [],
    tcpRelays: relayPorts.map(relayOn),
});

type NodeCallback = (error?: Error) => void;

// The listener's own close, called directly, so a test can stand in for it on one listener.
const closeForReal = (listener: NetServer, callback: NodeCallback): NetServer =>
    listener instanceof HttpServer
        ? HttpServer.prototype.close.call(listener, callback)
        : NetServer.prototype.close.call(listener, callback);

// Every listener's close finishes, but reports `problem` to whoever asked.
function reportingCloseFailure(
    context: TestContext,
    listeners: readonly NetServer[],
    problem: Error,
): void {
    for (const listener of listeners) {
        context.mock.method(listener, "close", (callback?: NodeCallback): NetServer =>
            closeForReal(listener, () => {
                callback?.(problem);
            }),
        );
    }
}

type HeldClose = { release(): void };

// A TCP relay's close waits until release() is called; an HTTP listener's close goes through.
function holdingRelayClose(context: TestContext, listeners: readonly NetServer[]): HeldClose {
    const held: (() => void)[] = [];
    for (const listener of listeners.filter((each) => !(each instanceof HttpServer))) {
        context.mock.method(listener, "close", (callback?: NodeCallback): NetServer =>
            closeForReal(listener, () => {
                held.push(() => {
                    callback?.();
                });
            }),
        );
    }
    return {
        release() {
            for (const finish of held) {
                finish();
            }
        },
    };
}

// The listeners opened while `opening` runs, in order, and what it gave.
async function listenersOpenedBy<Value>(
    context: TestContext,
    opening: () => Promise<Value>,
): Promise<{ readonly value: Value; readonly listeners: readonly NetServer[] }> {
    const listen = context.mock.method(NetServer.prototype, "listen");
    const value = await opening();
    const listeners = listen.mock.calls.flatMap((call) =>
        call.this instanceof NetServer ? [call.this] : [],
    );
    listen.mock.restore();
    return { value, listeners };
}

const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

const RULES_DECLARING_NOTHING = { allowedOrigins: [], privateOrigins: [], rewrites: [] };
const LISTENER_REASON = "the decision listener failed";
const UNDECLARED_TARGET = "http://undeclared.test/";
const ANSWER_LIMIT_MILLISECONDS = 1500;

const DECIDED_REQUESTS: readonly {
    readonly title: string;
    readonly ask: (proxyUrl: string) => Promise<number>;
}[] = [
    {
        title: "a plain request to an undeclared origin",
        ask: async (proxyUrl) =>
            (await getThroughProxy(proxyUrl, UNDECLARED_TARGET, ANSWER_LIMIT_MILLISECONDS)).status,
    },
    {
        title: "a tunnel to an undeclared origin",
        ask: (proxyUrl) =>
            connectThroughProxy(proxyUrl, "undeclared.test:443", ANSWER_LIMIT_MILLISECONDS),
    },
];

describe("Using the egress proxy", () => {
    describe("given every port it needs is free but one", () => {
        const cases: readonly {
            readonly title: string;
            readonly build: (
                occupied: number,
                free: readonly number[],
            ) => {
                readonly relayPorts: readonly number[];
                readonly servicePort?: number;
                readonly port?: number;
            };
        }[] = [
            {
                title: "and its main port is taken, with a relay and a service port already up",
                build: (occupied, free) => ({
                    relayPorts: [free[0] ?? 0],
                    servicePort: free[1] ?? 0,
                    port: occupied,
                }),
            },
            {
                title: "and its service port is taken, with a relay already up",
                build: (occupied, free) => ({ relayPorts: [free[0] ?? 0], servicePort: occupied }),
            },
            {
                title: "and a relay's port is taken, with an earlier relay already up",
                build: (occupied, free) => ({ relayPorts: [free[0] ?? 0, occupied] }),
            },
        ];

        for (const { title, build } of cases) {
            describe(title, () => {
                describe("when the proxy starts", () => {
                    test("then it should give a failed outcome naming the listen failure and free every port", async () => {
                        const occupier = await occupiedPort();
                        const free = [await closedPort(), await closedPort()];
                        const { relayPorts, servicePort, port } = build(occupier.port, free);
                        try {
                            const started = await startProxyServer(
                                parsedProxyRules(rulesWithRelays(relayPorts)),
                                {
                                    ...(servicePort === undefined ? {} : { servicePort }),
                                    ...(port === undefined ? {} : { port }),
                                },
                            );
                            assert.ok(!started.ok, JSON.stringify(started));
                            assert.ok(
                                started.error.code === LISTEN_FAILED_CODE,
                                JSON.stringify(started),
                            );
                            assert.equal(started.error.port, occupier.port);
                            assert.match(started.error.message, ADDRESS_IN_USE);
                            for (const usedPort of [...relayPorts, servicePort]) {
                                if (usedPort !== undefined && usedPort !== occupier.port) {
                                    assert.equal(
                                        await isFree(usedPort),
                                        true,
                                        `port ${usedPort} is free again`,
                                    );
                                }
                            }
                        } finally {
                            await occupier.close();
                        }
                    });
                });
            });
        }

        describe("and two relays on one port", () => {
            describe("when the proxy starts", () => {
                test("then it should give a failed outcome naming that port and free it", async () => {
                    const relayPort = await closedPort();
                    const started = await startProxyServer(
                        parsedProxyRules(rulesWithRelays([relayPort, relayPort])),
                    );
                    assert.ok(!started.ok, JSON.stringify(started));
                    assert.ok(started.error.code === LISTEN_FAILED_CODE, JSON.stringify(started));
                    assert.equal(started.error.port, relayPort);
                    assert.equal(await isFree(relayPort), true);
                });
            });
        });
    });

    describe("given a running proxy with a relay", () => {
        const startWithRelay = async (
            context: TestContext,
        ): Promise<{ readonly value: EgressProxy; readonly listeners: readonly NetServer[] }> => {
            const relayPort = await closedPort();
            return listenersOpenedBy(context, () =>
                startedProxyServer(rulesWithRelays([relayPort])),
            );
        };

        describe("and a listener whose close fails", () => {
            describe("when the proxy closes", () => {
                test("then it should report the failure rather than lose it", async (context) => {
                    const { value: proxy, listeners } = await startWithRelay(context);
                    reportingCloseFailure(
                        context,
                        listeners,
                        new Error("the listener would not close"),
                    );
                    const closed = await proxy.close();
                    assert.ok(!closed.ok, JSON.stringify(closed));
                    assert.match(closed.error.message, /the listener would not close/);
                });
            });
        });

        describe("and a relay whose close takes a while", () => {
            describe("when the proxy closes", () => {
                test("then it should wait for the relay before it says it has closed", async (context) => {
                    const { value: proxy, listeners } = await startWithRelay(context);
                    const held = holdingRelayClose(context, listeners);
                    let isClosed = false;
                    const closing = proxy.close().then(() => {
                        isClosed = true;
                    });
                    await flush();
                    assert.equal(
                        isClosed,
                        false,
                        "the proxy said it closed while a relay was closing",
                    );
                    held.release();
                    await closing;
                    assert.equal(isClosed, true);
                });
            });
        });

        describe("and a proxy that has closed", () => {
            describe("when it is closed a second time", () => {
                test("then it should give the same successful outcome", async (context) => {
                    const { value: proxy } = await startWithRelay(context);
                    await proxy.close();
                    const second = await proxy.close();
                    assert.equal(second.ok, true);
                });
            });
        });
    });

    describe("given a running proxy with every kind of listener", () => {
        describe("and a listener that fails after listening, such as on an accept", () => {
            describe("when that happens", () => {
                test("then it should report the failure, keep the process alive and keep serving", async (context) => {
                    const relayPort = await closedPort();
                    const servicePort = await closedPort();
                    const { value: proxy, listeners } = await listenersOpenedBy(context, () =>
                        startedProxyServer(rulesWithRelays([relayPort]), {
                            servicePort,
                            resolve: fakeResolver({}).resolve,
                        }),
                    );
                    try {
                        assert.equal(
                            listeners.length,
                            3,
                            "a relay, a service port and a main port",
                        );
                        for (const [index, listener] of listeners.entries()) {
                            const message = `accept failed on listener ${index}`;
                            assert.doesNotThrow(() => {
                                listener.emit("error", new Error(message));
                            });
                            assert.ok(
                                proxy
                                    .listenerFailures()
                                    .some((failure) => failure.message.includes(message)),
                                JSON.stringify(proxy.listenerFailures()),
                            );
                        }
                        const answer = await getThroughProxy(proxy.url, "http://undeclared.test/");
                        assert.equal(answer.status, 403);
                    } finally {
                        await proxy.close();
                    }
                });
            });
        });
    });

    describe("given a decision listener that throws", () => {
        let proxy: EgressProxy;
        let listenerCalls: number;
        const unhandled: unknown[] = [];
        const noteUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };

        beforeEach(async () => {
            unhandled.length = 0;
            listenerCalls = 0;
            process.on("unhandledRejection", noteUnhandled);
            proxy = await startedProxyServer(RULES_DECLARING_NOTHING, {
                resolve: fakeResolver({}).resolve,
                onDecision: () => {
                    listenerCalls += 1;
                    throw new Error(LISTENER_REASON);
                },
            });
        });
        afterEach(async () => {
            process.off("unhandledRejection", noteUnhandled);
            await proxy.close();
        });

        for (const { title, ask } of DECIDED_REQUESTS) {
            describe(`and ${title}`, () => {
                describe("when the proxy decides it", () => {
                    test("then it should answer, keep the decision, note the throw and leave no unhandled rejection", async () => {
                        const status = await ask(proxy.url);
                        await flush();
                        assert.equal(status, 403);
                        assert.deepEqual(unhandled, []);
                        assert.equal(proxy.decisions().length, 1);
                        assert.equal(listenerCalls, 1);
                        assert.ok(
                            proxy
                                .listenerFailures()
                                .some((failure) => failure.message.includes(LISTENER_REASON)),
                            JSON.stringify(proxy.listenerFailures()),
                        );
                    });
                });
            });
        }

        describe("and a request has already made it throw", () => {
            describe("when another request arrives", () => {
                test("then it should keep serving", async () => {
                    await getThroughProxy(proxy.url, UNDECLARED_TARGET, ANSWER_LIMIT_MILLISECONDS);
                    const second = await getThroughProxy(
                        proxy.url,
                        UNDECLARED_TARGET,
                        ANSWER_LIMIT_MILLISECONDS,
                    );
                    await flush();
                    assert.equal(second.status, 403);
                    assert.equal(proxy.decisions().length, 2);
                    assert.equal(listenerCalls, 2);
                    assert.deepEqual(unhandled, []);
                });
            });
        });
    });
});
