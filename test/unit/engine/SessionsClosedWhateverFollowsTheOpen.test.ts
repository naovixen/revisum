// A session that opened is closed, whatever throws before the steps begin, so no browser is left
// running behind a run that has given up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Session } from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";
import { closedSession } from "#test-support/fakes/FakeSession.ts";

const BROWSER_UNREADABLE = "the browser could not say its name and version";

describe("Using the run", () => {
    describe("given a session that opens", () => {
        describe("and whose browser cannot be read for the manifest", () => {
            describe("when the run starts", () => {
                test("then it should reject with that failure, and close the session once", async (context) => {
                    const close = context.mock.fn(() => Promise.resolve(closedSession()));
                    const opened = fakeSessionOnOrders({ close });
                    const session: Session = new Proxy(opened, {
                        get(target, key, receiver): unknown {
                            if (key === "browser") {
                                throw new Error(BROWSER_UNREADABLE);
                            }
                            return Reflect.get(target, key, receiver);
                        },
                    });
                    await assert.rejects(runOnFakeSession(unsafePlan([OPEN_CART]), { session }), {
                        message: BROWSER_UNREADABLE,
                    });
                    assert.equal(close.mock.callCount(), 1);
                    assert.deepEqual(close.mock.calls[0]?.arguments, []);
                });
            });
        });
    });
});
