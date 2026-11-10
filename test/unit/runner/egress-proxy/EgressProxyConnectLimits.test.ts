// What ends a connection attempt. A connector that throws at once is one more failed connection, not
// a rejected promise that ends the process. A resolver that never answers, and a name whose every
// address silently drops the attempt, must both end within the one 30-second limit a connection has,
// so a dead origin can't hold a request open. That limit is shared fairly: each attempt gets the time
// left divided by the addresses left, so a silent first address can't starve a working second one.
// Time is mocked: the limit may be kept with setTimeout or a socket's setTimeout, and
// SilentlyDroppingSocket keeps a socket's on that same mock clock.
import assert from "node:assert/strict";
import { once } from "node:events";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";
import { type AddressConnector, type AddressResolver, type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    exchangeWithProxy,
    plainRequestText,
    startUpstream,
    tunnelRequestText,
} from "../support/GetThroughProxy.ts";

const CONNECT_LIMIT_MILLISECONDS = 30_000;
const EARLIEST_ALLOWED_END = 29_000;
const LATEST_ALLOWED_END = 31_000;
const LONGEST_WAIT_MILLISECONDS = 45_000;
const TICK_MILLISECONDS = 10;
const SHORT_REAL_LIMIT_MILLISECONDS = 1500;
// Only a backstop: mock time decides these tests, and it can take a loaded machine a while to run.
const BACKSTOP_REAL_LIMIT_MILLISECONDS = 20_000;
const CONNECTOR_REASON = "the connector could not open a socket";
const DROPPING_ADDRESSES = ["93.184.215.1", "93.184.215.2", "93.184.215.3", "93.184.215.4"];
const DROPPING_ADDRESS = "93.184.215.1";
const ACCEPTING_ADDRESS = "93.184.215.2";
// Half of the limit, the share of the first of two addresses, with room for the ticks of mock time.
const EARLIEST_FAIR_SHARE_OF_TWO = 14_000;
const LATEST_FAIR_SHARE_OF_TWO = 16_000;
const LOOKUP_MILLISECONDS = 10_000;
// A lookup of 10 s leaves 20 s for two addresses, so the second is tried 10 s after it answers.
const EARLIEST_SHARE_AFTER_LOOKUP = 19_000;
const LATEST_SHARE_AFTER_LOOKUP = 21_000;

const RULES = {
    allowedOrigins: ["http://service.test", "https://service.test"],
    privateOrigins: [],
    rewrites: [],
};

const REQUESTS = [
    {
        title: "a plain request",
        text: plainRequestText("http://service.test"),
        origin: "http://service.test",
    },
    { title: "a tunnel", text: tunnelRequestText("service.test:443"), origin: "service.test:443" },
] as const;

// A connection that never opens and never fails, with its timeout kept on the mock clock, so a limit
// set through the socket or through setTimeout passes in the same mock time.
class SilentlyDroppingSocket extends Socket {
    #limit: NodeJS.Timeout | undefined;

    override setTimeout(milliseconds: number, listener?: () => void): this {
        if (this.#limit !== undefined) {
            clearTimeout(this.#limit);
        }
        if (milliseconds === 0) {
            if (listener !== undefined) {
                this.off("timeout", listener);
            }
            return this;
        }
        if (listener !== undefined) {
            this.once("timeout", listener);
        }
        this.#limit = setTimeout(() => {
            this.emit("timeout");
        }, milliseconds);
        return this;
    }
}

const nextTurn = (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve);
    });

// Runs mock time forward until `done` says so, starting once `started` says so, and says how much
// mock time passed. A test's `done` is the proxy noting the failure, which happens on the mock clock:
// the client's answer travels in real time, and a real millisecond is a lot of mock time at this pace.
async function mockTimeUntil(
    context: TestContext,
    started: () => boolean,
    done: () => boolean,
): Promise<number> {
    let turns = 0;
    while (!started() && !done() && turns < 5000) {
        await nextTurn();
        turns += 1;
    }
    let elapsed = 0;
    while (!done() && elapsed < LONGEST_WAIT_MILLISECONDS) {
        context.mock.timers.tick(TICK_MILLISECONDS);
        elapsed += TICK_MILLISECONDS;
        await nextTurn();
    }
    return elapsed;
}

type WatchedExchange = {
    readonly outcome: { isDone: boolean; received: string };
    readonly finished: Promise<void>;
};

// An exchange a test can look at between ticks of mock time, whose failure only leaves it unfilled.
function watchedExchange(proxy: EgressProxy, text: string): WatchedExchange {
    const outcome = { isDone: false, received: "" };
    const finished = exchangeWithProxy(proxy.url, text, BACKSTOP_REAL_LIMIT_MILLISECONDS).then(
        (received) => {
            outcome.received = received;
            outcome.isDone = true;
        },
        () => {
            outcome.isDone = true;
        },
    );
    return { outcome, finished };
}

describe("Using the egress proxy", () => {
    describe("given a connector that throws as soon as it is called", () => {
        const throwingConnector: AddressConnector = () => {
            throw new Error(CONNECTOR_REASON);
        };
        let proxy: EgressProxy;
        const unhandled: unknown[] = [];
        const noteUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };

        beforeEach(async () => {
            unhandled.length = 0;
            process.on("unhandledRejection", noteUnhandled);
            proxy = await startedProxyServer(RULES, {
                resolve: () => Promise.resolve(["93.184.215.14"]),
                connect: throwingConnector,
            });
        });
        afterEach(async () => {
            process.off("unhandledRejection", noteUnhandled);
            await proxy.close();
        });

        for (const { title, text, origin } of REQUESTS) {
            describe(`and ${title}`, () => {
                describe("when the proxy tries to connect", () => {
                    test("then it should fail like any connection, with no unhandled rejection", async () => {
                        const received = await exchangeWithProxy(
                            proxy.url,
                            text,
                            SHORT_REAL_LIMIT_MILLISECONDS,
                        );
                        await nextTurn();
                        assert.match(received, /^HTTP\/1\.1 502/);
                        assert.equal(proxy.connectionFailures()[0]?.origin, origin);
                        assert.match(
                            proxy.connectionFailures()[0]?.message ?? "",
                            new RegExp(CONNECTOR_REASON),
                        );
                        assert.deepEqual(unhandled, []);
                    });
                });
            });
        }
    });

    describe("given a resolver that never answers", () => {
        for (const { title, text, origin } of REQUESTS) {
            describe(`and ${title}`, () => {
                describe("when the proxy waits on the lookup", () => {
                    test("then it should end the request within the connect limit", async (context) => {
                        let asked = 0;
                        const neverAnswers: AddressResolver = () => {
                            asked += 1;
                            return new Promise(() => undefined);
                        };
                        const proxy = await startedProxyServer(RULES, {
                            resolve: neverAnswers,
                            connect: () => new SilentlyDroppingSocket(),
                        });
                        context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
                        const outcome = { isDone: false, received: "" };
                        const exchange = exchangeWithProxy(
                            proxy.url,
                            text,
                            BACKSTOP_REAL_LIMIT_MILLISECONDS,
                        ).then(
                            (received) => {
                                outcome.received = received;
                                outcome.isDone = true;
                            },
                            () => {
                                outcome.isDone = true;
                            },
                        );
                        try {
                            const elapsed = await mockTimeUntil(
                                context,
                                () => asked > 0,
                                () => outcome.isDone || proxy.connectionFailures().length > 0,
                            );
                            assert.ok(
                                elapsed <= LATEST_ALLOWED_END,
                                `took ${elapsed} ms of mock time`,
                            );
                            await exchange;
                            assert.match(outcome.received, /^HTTP\/1\.1 502/);
                            assert.equal(proxy.connectionFailures()[0]?.origin, origin);
                        } finally {
                            context.mock.timers.reset();
                            await proxy.close();
                        }
                    });
                });
            });
        }
    });

    describe("given a name whose four addresses all silently drop the attempt", () => {
        describe("when the proxy connects across them", () => {
            test("then it should end near one connect limit, not one per address", async (context) => {
                const attempts: string[] = [];
                const connector: AddressConnector = (address) => {
                    attempts.push(address);
                    return new SilentlyDroppingSocket();
                };
                const proxy = await startedProxyServer(RULES, {
                    resolve: () => Promise.resolve(DROPPING_ADDRESSES),
                    connect: connector,
                });
                context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
                const outcome = { isDone: false, received: "" };
                const exchange = exchangeWithProxy(
                    proxy.url,
                    plainRequestText("http://service.test"),
                    BACKSTOP_REAL_LIMIT_MILLISECONDS,
                ).then(
                    (received) => {
                        outcome.received = received;
                        outcome.isDone = true;
                    },
                    () => {
                        outcome.isDone = true;
                    },
                );
                try {
                    const elapsed = await mockTimeUntil(
                        context,
                        () => attempts.length > 0,
                        () => outcome.isDone || proxy.connectionFailures().length > 0,
                    );
                    assert.ok(
                        elapsed >= EARLIEST_ALLOWED_END && elapsed <= LATEST_ALLOWED_END,
                        `took ${elapsed} ms of mock time, for a limit of ${CONNECT_LIMIT_MILLISECONDS}`,
                    );
                    await exchange;
                    assert.match(outcome.received, /^HTTP\/1\.1 502/);
                    assert.deepEqual(attempts, DROPPING_ADDRESSES);
                } finally {
                    context.mock.timers.reset();
                    await proxy.close();
                }
            });
        });
    });

    describe("given a name whose first address silently drops the attempt", () => {
        describe("and whose second address accepts", () => {
            describe("when the proxy connects across them", () => {
                test("then it should give the first address half the limit and connect to the second", async (context) => {
                    const upstream = await startUpstream();
                    const attempts: string[] = [];
                    const connector: AddressConnector = (address, port) => {
                        attempts.push(address);
                        return address === DROPPING_ADDRESS
                            ? new SilentlyDroppingSocket()
                            : upstream.connect(address, port);
                    };
                    const proxy = await startedProxyServer(RULES, {
                        resolve: () => Promise.resolve([DROPPING_ADDRESS, ACCEPTING_ADDRESS]),
                        connect: connector,
                    });
                    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
                    const exchange = watchedExchange(
                        proxy,
                        plainRequestText("http://service.test"),
                    );
                    try {
                        const elapsed = await mockTimeUntil(
                            context,
                            () => attempts.length > 0,
                            () => attempts.length > 1 || exchange.outcome.isDone,
                        );
                        assert.ok(
                            elapsed >= EARLIEST_FAIR_SHARE_OF_TWO &&
                                elapsed <= LATEST_FAIR_SHARE_OF_TWO,
                            `the first address held the walk for ${elapsed} ms of mock time`,
                        );
                        await exchange.finished;
                        assert.deepEqual(attempts, [DROPPING_ADDRESS, ACCEPTING_ADDRESS]);
                        assert.match(exchange.outcome.received, /^HTTP\/1\.1 200/);
                        assert.deepEqual(upstream.hosts, ["service.test"]);
                    } finally {
                        context.mock.timers.reset();
                        await proxy.close();
                        await upstream.close();
                    }
                });
            });
        });

        describe("and whose lookup used up part of the limit", () => {
            describe("when the proxy connects across its two addresses", () => {
                test("then it should share out only the time left", async (context) => {
                    let asked = 0;
                    const attempts: string[] = [];
                    const connector: AddressConnector = (address) => {
                        attempts.push(address);
                        return new SilentlyDroppingSocket();
                    };
                    const slowResolver: AddressResolver = () => {
                        asked += 1;
                        return new Promise((resolve) => {
                            setTimeout(() => {
                                resolve([DROPPING_ADDRESS, ACCEPTING_ADDRESS]);
                            }, LOOKUP_MILLISECONDS);
                        });
                    };
                    const proxy = await startedProxyServer(RULES, {
                        resolve: slowResolver,
                        connect: connector,
                    });
                    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
                    const exchange = watchedExchange(
                        proxy,
                        plainRequestText("http://service.test"),
                    );
                    try {
                        const elapsed = await mockTimeUntil(
                            context,
                            () => asked > 0,
                            () => attempts.length > 1 || exchange.outcome.isDone,
                        );
                        assert.ok(
                            elapsed >= EARLIEST_SHARE_AFTER_LOOKUP &&
                                elapsed <= LATEST_SHARE_AFTER_LOOKUP,
                            `the second address was tried after ${elapsed} ms of mock time`,
                        );
                    } finally {
                        context.mock.timers.reset();
                        await proxy.close();
                        await exchange.finished;
                    }
                });
            });
        });
    });

    describe("given a connector that gives back a socket already closed and done", () => {
        for (const { title, text, origin } of REQUESTS) {
            describe(`and ${title}`, () => {
                describe("when the proxy waits for it to open", () => {
                    test("then it should end the walk by the connect limit, not hang", async (context) => {
                        const finished = new Socket();
                        finished.destroy();
                        await once(finished, "close");
                        let attempts = 0;
                        const proxy = await startedProxyServer(RULES, {
                            resolve: () => Promise.resolve(["93.184.215.14"]),
                            connect: () => {
                                attempts += 1;
                                return finished;
                            },
                        });
                        context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
                        const exchange = watchedExchange(proxy, text);
                        try {
                            const elapsed = await mockTimeUntil(
                                context,
                                () => attempts > 0,
                                () =>
                                    exchange.outcome.isDone ||
                                    proxy.connectionFailures().length > 0,
                            );
                            assert.ok(
                                elapsed <= LATEST_ALLOWED_END,
                                `took ${elapsed} ms of mock time`,
                            );
                            await exchange.finished;
                            assert.match(exchange.outcome.received, /^HTTP\/1\.1 502/);
                            assert.equal(proxy.connectionFailures()[0]?.origin, origin);
                        } finally {
                            context.mock.timers.reset();
                            await proxy.close();
                        }
                    });
                });
            });
        }
    });
});
