// Three records are read once the steps have run: the request decisions the browser refused, what the
// egress proxy rewrote and which stubs answered. A result that went on without one would claim what
// nobody saw, so a review item tells a person which record went unread. A run with a refusal cannot
// pass, nor one that may have tested a rewritten app, so without those two records the run gives no
// verdict; unread stub answers leave the steps' verdict standing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunPorts, RunResult, Session } from "@revisum/engine";
import { fakeNetwork, fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";

const BROKEN = "the record could not be read";
const RECORDS_UNREAD = "session-records-unread";

const throws = (): never => {
    throw new Error(BROKEN);
};

// A session whose refused decisions can be read while the steps run, but not once it has closed.
function sessionWhoseRefusalsGoUnreadAfterClose(): Session {
    let isClosed = false;
    return fakeSessionOnOrders({
        refusedRequestDecisions: () => (isClosed ? throws() : []),
        close: () => {
            isClosed = true;
            return Promise.resolve();
        },
    });
}

type UnreadRecord = {
    readonly name: string;
    readonly code: string;
    readonly state: string;
    readonly session: () => Session;
    readonly rewritesApplied?: RunPorts["rewritesApplied"];
};

const UNREAD_RECORDS: readonly UnreadRecord[] = [
    {
        name: "whose refused request decisions cannot be read once it has closed",
        code: "refusals-unread",
        state: "Errored",
        session: sessionWhoseRefusalsGoUnreadAfterClose,
    },
    {
        name: "behind an egress proxy whose rewrites cannot be read",
        code: "rewrites-unread",
        state: "Errored",
        session: () => fakeSessionOnOrders(),
        rewritesApplied: throws,
    },
    {
        name: "whose stub answers cannot be read",
        code: "stub-answers-unread",
        state: "Passed",
        session: () => fakeSessionOnOrders({ network: { ...fakeNetwork(), stubAnswers: throws } }),
    },
];

const UNREAD_CODES: readonly string[] = UNREAD_RECORDS.map((record) => record.code);

const runWith = (record: UnreadRecord, session: Session = record.session()) =>
    runOnFakeSession(unsafePlan([OPEN_CART]), {
        session,
        ...(record.rewritesApplied === undefined
            ? {}
            : { rewritesApplied: record.rewritesApplied }),
    });

// Review items are compared as plain data, so the result's own type does not decide which codes exist.
const reviewItemsOf = (result: RunResult): readonly unknown[] => result.reviewItems ?? [];

const itemsWithCode = (result: RunResult, code: string): readonly unknown[] =>
    reviewItemsOf(result).filter(
        (item) => typeof item === "object" && item !== null && "code" in item && item.code === code,
    );

describe("Using the run", () => {
    describe("given steps that pass", () => {
        for (const record of UNREAD_RECORDS) {
            describe(`and a session ${record.name}`, () => {
                describe("when the run ends", () => {
                    test(`then it should end ${record.state}`, async () => {
                        const { result } = await runWith(record);
                        assert.equal(result.state, record.state);
                    });

                    test(`then it should hold one review item saying ${record.code}`, async () => {
                        const { result } = await runWith(record);
                        assert.deepEqual(itemsWithCode(result, record.code), [
                            { code: record.code },
                        ]);
                    });

                    test("then it should log the failure once as session-records-unread", async () => {
                        const { events } = await runWith(record);
                        const logged = events
                            .read()
                            .filter((event) => event.code === RECORDS_UNREAD)
                            .map((event) => event.detail);
                        assert.deepEqual(logged, [BROKEN]);
                    });

                    test("then it should keep the failure's text out of the result", async () => {
                        const { result } = await runWith(record);
                        assert.equal(JSON.stringify(result).includes(BROKEN), false);
                    });

                    test("then it should close the session once", async (context) => {
                        const session = record.session();
                        const close = context.mock.fn(() => session.close());
                        await runWith(record, { ...session, close });
                        assert.equal(close.mock.callCount(), 1);
                    });
                });

                describe("and whose close rejects too", () => {
                    describe("when the run ends", () => {
                        test(`then it should end ${record.state} with one review item saying ${record.code}`, async () => {
                            const session = record.session();
                            const close = async (): Promise<void> => {
                                await session.close();
                                throw new Error(BROKEN);
                            };
                            const { result } = await runWith(record, { ...session, close });
                            assert.equal(result.state, record.state);
                            assert.deepEqual(itemsWithCode(result, record.code), [
                                { code: record.code },
                            ]);
                        });
                    });
                });
            });
        }

        describe("and a session whose records can all be read", () => {
            describe("when the run ends", () => {
                test("then it should pass with no review item saying a record went unread", async () => {
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        rewritesApplied: () => [],
                    });
                    assert.equal(result.state, "Passed");
                    assert.deepEqual(
                        UNREAD_CODES.flatMap((code) => itemsWithCode(result, code)),
                        [],
                    );
                });
            });
        });
    });
});
