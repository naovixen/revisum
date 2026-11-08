// A host run learns how its egress went from what the session egress reports, so a listener's failure
// while the proxy is up must be in that report: without it, the record may be incomplete unnoticed.
import assert from "node:assert/strict";
import { Server as NetServer } from "node:net";
import { describe, test } from "node:test";
import { startHostSessionEgress } from "../../../packages/cli/src/BuildAdapters.ts";

const SESSION_ORIGIN = "http://127.0.0.1:4173";
const LISTENER_REASON = "accept failed on the proxy's listener";

describe("Using a host run's session egress", () => {
    describe("given a proxy that is running", () => {
        describe("and a listener that fails after listening", () => {
            describe("when the session's failures are read", () => {
                test("then it should report the listener's failure", async (context) => {
                    const listen = context.mock.method(NetServer.prototype, "listen");
                    const egress = await startHostSessionEgress([SESSION_ORIGIN]);
                    const listeners = listen.mock.calls.flatMap((call) =>
                        call.this instanceof NetServer ? [call.this] : [],
                    );
                    listen.mock.restore();
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
