// What the egress proxy rewrote is read once the steps have run. A proxy that cannot say must not
// leave a mutated run reading as plain, and must not be asked twice: its failure goes to the log
// once, as the run logs every other failure after the verdict.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runOnFakeSession } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";

const REWRITES_UNREADABLE = "the egress proxy could not say what it rewrote";
const RECORDS_UNREAD = "session-records-unread";

type AppliedRewrites = readonly { readonly origin: string; readonly name: string }[];

// A proxy that fails the first time it is asked, and would answer "nothing" after, so a second
// question would hide the first failure.
const rewritesFailingOnce = (): {
    readonly read: () => AppliedRewrites;
    readonly callCount: () => number;
} => {
    let calls = 0;
    return {
        read: () => {
            calls += 1;
            if (calls === 1) {
                throw new Error(REWRITES_UNREADABLE);
            }
            return [];
        },
        callCount: () => calls,
    };
};

describe("Using the run", () => {
    describe("given steps that pass", () => {
        describe("and an egress proxy whose rewrites cannot be read", () => {
            describe("when the run ends", () => {
                test("then it should ask the proxy what it rewrote once", async () => {
                    const rewrites = rewritesFailingOnce();
                    await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        rewritesApplied: rewrites.read,
                    });
                    assert.equal(rewrites.callCount(), 1);
                });

                test("then it should log the proxy's failure once as session-records-unread", async () => {
                    const rewrites = rewritesFailingOnce();
                    const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        rewritesApplied: rewrites.read,
                    });
                    const logged = events.read().filter((event) => event.code === RECORDS_UNREAD);
                    assert.deepEqual(
                        logged.map((event) => [event.kind, event.outcome, event.detail]),
                        [["step.end", "failed", REWRITES_UNREADABLE]],
                    );
                });

                test("then it should end Errored, since it cannot say whether it tested a mutated app", async () => {
                    const rewrites = rewritesFailingOnce();
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        rewritesApplied: rewrites.read,
                    });
                    assert.equal(result.state, "Errored");
                });
            });
        });

        describe("and an egress proxy that says it rewrote nothing", () => {
            describe("when the run ends", () => {
                test("then it should log no unread records and pass", async () => {
                    const { result, events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        rewritesApplied: () => [],
                    });
                    assert.equal(
                        events.read().some((event) => event.code === RECORDS_UNREAD),
                        false,
                    );
                    assert.equal(result.state, "Passed");
                });
            });
        });
    });
});
