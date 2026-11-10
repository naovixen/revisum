// Once the steps have a verdict, a person needs it more than anything a broken session or log has
// left to say. Stub answers, the session's close and the log may all throw by then, and the result
// must still come back with that verdict, with the browser closed. Stub answers that went unread add a
// review item saying so, since the result would otherwise claim no stub answered. Blocked origins are
// not among them, because the result claims them.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { EventKind, success, type RunEventSink, type Session } from "@revisum/engine";
import {
    fakeSessionOnOrders,
    runOnFakeSession,
    stepSummaries,
    fakeNetwork,
} from "../examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";
import { fakeRunEventSinkFailingOn } from "#test-support/fakes/ports/FakeRunEventSink.ts";
import { closedSession, notingBlockedOrigins } from "#test-support/fakes/session/FakeSession.ts";

const BROKEN = "the session has gone";
const throws = (): never => {
    throw new Error(BROKEN);
};
const BLOCKED_ORIGIN = "https://blocked.example.test";
const RECORDS_UNREAD = "session-records-unread";
const STUB_ANSWERS_UNREAD = "stub-answers-unread";

const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};

const VERDICTS: readonly {
    readonly name: string;
    readonly steps: readonly JsonRecord[];
    readonly state: string;
}[] = [
    { name: "steps that pass", steps: [OPEN_CART], state: "Passed" },
    { name: "a check that fails", steps: [OPEN_CART, FAILING_CHECK], state: "Failed" },
];

const FINAL_STATES: readonly unknown[] = ["Passed", "Failed", "Errored", "Denied"];

// A log that works until the steps have a verdict, and then fails on everything.
const logFailingAfterTheVerdict = (): RunEventSink =>
    fakeRunEventSinkFailingOn(
        (event) =>
            event.kind === EventKind.NetworkBlocked ||
            (event.kind === EventKind.RunState && FINAL_STATES.includes(event.state)),
    );

const BROKEN_READS: readonly {
    readonly name: string;
    readonly changes: Partial<Session>;
    readonly isStubAnswersUnread: boolean;
}[] = [
    {
        name: "stubAnswers throws",
        changes: { network: { ...fakeNetwork(), stubAnswers: throws } },
        isStubAnswersUnread: true,
    },
    {
        name: "close rejects",
        changes: { close: () => Promise.reject(new Error(BROKEN)) },
        isStubAnswersUnread: false,
    },
    {
        name: "stubAnswers and close both fail",
        changes: {
            network: { ...fakeNetwork(), stubAnswers: throws },
            close: () => Promise.reject(new Error(BROKEN)),
        },
        isStubAnswersUnread: true,
    },
];

const spiedClose = (context: TestContext, close: Session["close"]) => context.mock.fn(close);

describe("Using the run", () => {
    for (const verdict of VERDICTS) {
        for (const { name, changes, isStubAnswersUnread } of BROKEN_READS) {
            describe(`given ${verdict.name}`, () => {
                describe(`and a session where ${name}`, () => {
                    describe("when the run ends", () => {
                        if (isStubAnswersUnread) {
                            test("then it should give the verdict and steps a sound session gives, with one review item saying the stub answers went unread", async () => {
                                const raw = unsafePlan(verdict.steps);
                                const sound = await runOnFakeSession(raw);
                                const broken = await runOnFakeSession(raw, {
                                    session: fakeSessionOnOrders(changes),
                                });
                                assert.equal(broken.result.state, verdict.state);
                                assert.deepEqual(
                                    stepSummaries(broken.result),
                                    stepSummaries(sound.result),
                                );
                                assert.deepEqual(broken.result.reviewItems, [
                                    ...(sound.result.reviewItems ?? []),
                                    { code: STUB_ANSWERS_UNREAD },
                                ]);
                            });
                        } else {
                            test("then it should give the result a sound session gives", async () => {
                                const raw = unsafePlan(verdict.steps);
                                const sound = await runOnFakeSession(raw);
                                const broken = await runOnFakeSession(raw, {
                                    session: fakeSessionOnOrders(changes),
                                });
                                assert.equal(broken.result.state, verdict.state);
                                assert.deepEqual(
                                    stepSummaries(broken.result),
                                    stepSummaries(sound.result),
                                );
                                assert.equal(broken.result.resultHash, sound.result.resultHash);
                            });
                        }

                        test("then it should try to close the session once", async (context) => {
                            const close = spiedClose(
                                context,
                                changes.close ?? (() => Promise.resolve(closedSession())),
                            );
                            await runOnFakeSession(unsafePlan(verdict.steps), {
                                session: fakeSessionOnOrders({ ...changes, close }),
                            });
                            assert.equal(close.mock.callCount(), 1);
                        });

                        test("then it should keep the failure's text out of the result", async () => {
                            const { result } = await runOnFakeSession(unsafePlan(verdict.steps), {
                                session: fakeSessionOnOrders(changes),
                            });
                            assert.equal(JSON.stringify(result).includes(BROKEN), false);
                        });

                        if (isStubAnswersUnread) {
                            test("then it should say so in the log", async () => {
                                const { events } = await runOnFakeSession(
                                    unsafePlan(verdict.steps),
                                    { session: fakeSessionOnOrders(changes) },
                                );
                                const logged = events
                                    .read()
                                    .filter((event) => event.code === RECORDS_UNREAD);
                                assert.ok(logged.length > 0, "nothing was logged");
                                assert.equal(logged[0]?.detail, BROKEN);
                            });
                        }
                    });
                });
            });
        }

        describe(`given ${verdict.name}`, () => {
            describe("and a page the allow-list blocked", () => {
                describe("and a log that fails once the steps have a verdict", () => {
                    describe("when the run ends", () => {
                        test("then it should give the verdict and the blocked origin", async () => {
                            const raw = unsafePlan(verdict.steps);
                            const sessionOfOneRun = () =>
                                fakeSessionOnOrders(notingBlockedOrigins([BLOCKED_ORIGIN]));
                            const sound = await runOnFakeSession(raw, {
                                session: sessionOfOneRun(),
                            });
                            const { result } = await runOnFakeSession(raw, {
                                session: sessionOfOneRun(),
                                events: logFailingAfterTheVerdict(),
                            });
                            assert.equal(result.state, verdict.state);
                            assert.deepEqual(result.blockedOrigins, [BLOCKED_ORIGIN]);
                            assert.equal(result.resultHash, sound.result.resultHash);
                        });

                        test("then it should close the session once", async (context) => {
                            const close = spiedClose(context, () =>
                                Promise.resolve(
                                    closedSession({ blockedOrigins: success([BLOCKED_ORIGIN]) }),
                                ),
                            );
                            await runOnFakeSession(unsafePlan(verdict.steps), {
                                session: fakeSessionOnOrders({ close }),
                                events: logFailingAfterTheVerdict(),
                            });
                            assert.equal(close.mock.callCount(), 1);
                        });
                    });
                });
            });
        });
    }

    describe("given a session that reads all it should", () => {
        describe("when the run ends", () => {
            test("then it should log no unread records", async () => {
                const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]));
                assert.equal(
                    events.read().some((event) => event.code === RECORDS_UNREAD),
                    false,
                );
            });
        });
    });
});
