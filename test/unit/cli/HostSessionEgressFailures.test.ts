// A host run learns how its egress went from what the session egress reports, so a listener's failure
// while the proxy is up must be in that report: without it, the record may be incomplete unnoticed.
import assert from "node:assert/strict";
import { Server as HttpServer } from "node:http";
import { Server as NetServer } from "node:net";
import { describe, test } from "node:test";
import { success } from "@revisum/contracts";
import { startHostSessionEgress } from "../../../packages/cli/src/BuildAdapters.ts";

const SESSION_ORIGIN = "http://127.0.0.1:4173";
const LISTENER_REASON = "accept failed on the proxy's listener";
const ORIGIN_WITH_A_PASSWORD = "http://user:hunter2@x.test/";
const CLOSE_REASON = "the listener would not close";

type NodeCallback = (error?: Error) => void;

// The listener's own close, called directly, so a test can stand in for it.
const closeForReal = (listener: NetServer, callback: NodeCallback): NetServer =>
    listener instanceof HttpServer
        ? HttpServer.prototype.close.call(listener, callback)
        : NetServer.prototype.close.call(listener, callback);

describe("Using a host run's session egress", () => {
    describe("given origins the proxy's rules refuse", () => {
        describe("when the session's egress starts", () => {
            test("then it should answer with why, and not throw", async () => {
                const started = await startHostSessionEgress([ORIGIN_WITH_A_PASSWORD]);
                assert.equal(started.ok, false, JSON.stringify(started));
            });
        });
    });

    describe("given a proxy that is running", () => {
        describe("when the session's egress closes", () => {
            test("then it should answer that it closed", async () => {
                const started = await startHostSessionEgress([SESSION_ORIGIN]);
                assert.ok(started.ok, JSON.stringify(started));
                assert.deepEqual(await started.value.close(), success(undefined));
            });
        });

        describe("and listeners whose close fails", () => {
            describe("when the session's egress closes", () => {
                test("then it should answer with why, and not throw", async (context) => {
                    const listen = context.mock.method(NetServer.prototype, "listen");
                    const started = await startHostSessionEgress([SESSION_ORIGIN]);
                    const listeners = listen.mock.calls.flatMap((call) =>
                        call.this instanceof NetServer ? [call.this] : [],
                    );
                    listen.mock.restore();
                    assert.ok(started.ok, JSON.stringify(started));
                    for (const listener of listeners) {
                        context.mock.method(listener, "close", (callback?: NodeCallback) =>
                            closeForReal(listener, () => {
                                callback?.(new Error(CLOSE_REASON));
                            }),
                        );
                    }

                    const closed = await started.value.close();

                    assert.ok(!closed.ok, JSON.stringify(closed));
                    assert.match(closed.error, new RegExp(CLOSE_REASON));
                });
            });
        });

        describe("and a listener that fails after listening", () => {
            describe("when the session's failures are read", () => {
                test("then it should report the listener's failure", async (context) => {
                    const listen = context.mock.method(NetServer.prototype, "listen");
                    const started = await startHostSessionEgress([SESSION_ORIGIN]);
                    const listeners = listen.mock.calls.flatMap((call) =>
                        call.this instanceof NetServer ? [call.this] : [],
                    );
                    listen.mock.restore();
                    // A listener left open would keep this file's process from ever exiting.
                    context.after(() => {
                        for (const listener of listeners) {
                            listener.close();
                        }
                    });
                    assert.ok(started.ok, JSON.stringify(started));
                    const egress = started.value;
                    try {
                        assert.deepEqual(egress.connectionFailures(), []);
                        for (const listener of listeners) {
                            listener.emit("error", new Error(LISTENER_REASON));
                        }
                        assert.ok(
                            egress
                                .connectionFailures()
                                .some((failure) => failure.message.includes(LISTENER_REASON)),
                            JSON.stringify(egress.connectionFailures()),
                        );
                    } finally {
                        await egress.close();
                    }
                });
            });
        });
    });
});
