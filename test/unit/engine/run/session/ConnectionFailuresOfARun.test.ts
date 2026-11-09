// A declared origin the session could not connect to is a diagnostic for whoever is running: it goes to
// the run's log, one event per failure, and the result and its hash stay as they were, since a machine's
// network says nothing about the app.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    defaultRedactor,
    failure,
    success,
    type Result,
    type LoggedEvent,
    type RunEventSink,
    type Session,
} from "@revisum/engine";
import { evidenceHashOf } from "../../../../support/ExpectedEvidenceHash.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "../examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";
import { fakeRunEventSinkFailingOn } from "#test-support/fakes/ports/FakeRunEventSink.ts";
import { closedSession, notingBlockedOrigins } from "#test-support/fakes/session/FakeSession.ts";

type ConnectionFailure = { readonly origin: string; readonly message: string };

type SessionChanges = Partial<Session> & { readonly blockedOrigins?: () => readonly string[] };

const CONNECTION_FAILED = "session.connection-failed";
const RECORDS_UNREAD = "session-records-unread";
const BROKEN = "the session has gone";
const BLOCKED_ORIGIN = "https://blocked.example.test";
const PERSON = "ada@example.test";

const FAILURES: readonly ConnectionFailure[] = [
    { origin: "https://first.example.test", message: "Could not connect to the first." },
    { origin: "https://second.example.test", message: "Could not connect to the second." },
];

const FAILURE_NAMING_A_PERSON: ConnectionFailure = {
    origin: `https://${PERSON}`,
    message: `Could not connect for ${PERSON}.`,
};

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

const throws = (): never => {
    throw new Error(BROKEN);
};

// What a read gives as a record of the session: the value, or why it could not say.
function recordOf<Value>(read: () => Value): Result<Value, string> {
    try {
        return success(read());
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
}

// A session that has noted these connection failures, and the blocked origins it is told of.
function sessionReading(
    connectionFailures: () => readonly ConnectionFailure[],
    { blockedOrigins = () => [], ...changes }: SessionChanges = {},
): Session {
    return fakeSessionOnOrders({
        close: () =>
            Promise.resolve(
                closedSession({
                    connectionFailures: recordOf(connectionFailures),
                    blockedOrigins: recordOf(blockedOrigins),
                }),
            ),
        ...changes,
    });
}

const connectionFailedEvents = (events: RunEventSink): readonly LoggedEvent[] =>
    events.read().filter((event) => String(event.kind) === CONNECTION_FAILED);

const failuresLoggedIn = (events: RunEventSink): readonly ConnectionFailure[] =>
    connectionFailedEvents(events).map((event) => ({
        origin: event.origin ?? "",
        message: event.detail ?? "",
    }));

// A log that works until it is told of a connection failure.
const logFailingOnAConnectionFailure = (): RunEventSink =>
    fakeRunEventSinkFailingOn((event) => String(event.kind) === CONNECTION_FAILED);

describe("Using the run", () => {
    for (const verdict of VERDICTS) {
        describe(`given ${verdict.name}`, () => {
            const raw = unsafePlan(verdict.steps);

            describe("and a session that could not connect to two origins", () => {
                describe("when the run ends", () => {
                    test("then it should log one event per failure, with its origin and message", async () => {
                        const { events } = await runOnFakeSession(raw, {
                            session: sessionReading(() => FAILURES),
                        });
                        assert.deepEqual(failuresLoggedIn(events), FAILURES);
                    });

                    test("then it should read the failures once", async (context) => {
                        const read = context.mock.fn(() => FAILURES);
                        await runOnFakeSession(raw, { session: sessionReading(read) });
                        assert.equal(read.mock.callCount(), 1);
                    });

                    test("then it should give the verdict and hash of a session with no failures", async () => {
                        const sound = await runOnFakeSession(raw);
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionReading(() => FAILURES),
                        });
                        assert.equal(result.state, verdict.state);
                        assert.equal(result.resultHash, sound.result.resultHash);
                    });

                    test("then it should keep the failures out of the result", async () => {
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionReading(() => FAILURES),
                        });
                        const written = JSON.stringify(result);
                        for (const { origin, message } of FAILURES) {
                            assert.equal(written.includes(origin), false, origin);
                            assert.equal(written.includes(message), false, message);
                        }
                    });
                });
            });

            describe("and a session with no way to report connection failures", () => {
                describe("when the run ends", () => {
                    test("then it should give the verdict and hash of one that reports none", async () => {
                        const reportingNone = await runOnFakeSession(raw, {
                            session: sessionReading(() => []),
                        });
                        const { result, events } = await runOnFakeSession(raw);
                        assert.equal(result.state, verdict.state);
                        assert.equal(result.resultHash, reportingNone.result.resultHash);
                        assert.deepEqual(connectionFailedEvents(events), []);
                    });

                    test("then it should not say its records went unread", async () => {
                        const { events } = await runOnFakeSession(raw);
                        assert.equal(
                            events.read().some((event) => event.code === RECORDS_UNREAD),
                            false,
                        );
                    });
                });
            });

            describe("and a session whose read of connection failures throws", () => {
                describe("when the run ends", () => {
                    test("then it should give the verdict and hash of a session with no failures", async () => {
                        const sound = await runOnFakeSession(raw);
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionReading(throws),
                        });
                        assert.equal(result.state, verdict.state);
                        assert.equal(result.resultHash, sound.result.resultHash);
                    });

                    test("then it should say so in the log, as for any other unread record", async () => {
                        const { events } = await runOnFakeSession(raw, {
                            session: sessionReading(throws),
                        });
                        const logged = events
                            .read()
                            .filter((event) => event.code === RECORDS_UNREAD);
                        assert.deepEqual(
                            logged.map((event) => event.detail),
                            [BROKEN],
                        );
                    });

                    test("then it should log no connection failure", async () => {
                        const { events } = await runOnFakeSession(raw, {
                            session: sessionReading(throws),
                        });
                        assert.deepEqual(connectionFailedEvents(events), []);
                    });

                    test("then it should still give the blocked origins and close the session once", async (context) => {
                        const close = context.mock.fn(() =>
                            Promise.resolve(
                                closedSession({
                                    connectionFailures: failure(BROKEN),
                                    blockedOrigins: success([BLOCKED_ORIGIN]),
                                }),
                            ),
                        );
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionReading(throws, { close }),
                        });
                        assert.deepEqual(result.blockedOrigins, [BLOCKED_ORIGIN]);
                        assert.equal(close.mock.callCount(), 1);
                    });
                });
            });
        });
    }

    describe("given a session that reports no connection failures", () => {
        describe("when the run ends", () => {
            test("then it should log no connection failure", async () => {
                const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                    session: sessionReading(() => []),
                });
                assert.deepEqual(connectionFailedEvents(events), []);
            });
        });
    });

    describe("given a session that blocked an origin and could not connect to another", () => {
        describe("when the run ends", () => {
            test("then it should give the hashes of the same blocked origin with no failures", async () => {
                const raw = unsafePlan([OPEN_CART]);
                const blockedOrigins = (): readonly string[] => [BLOCKED_ORIGIN];
                const blockedOnly = await runOnFakeSession(raw, {
                    session: fakeSessionOnOrders(notingBlockedOrigins(blockedOrigins())),
                });
                const { result } = await runOnFakeSession(raw, {
                    session: sessionReading(() => FAILURES, { blockedOrigins }),
                });
                assert.deepEqual(result.blockedOrigins, [BLOCKED_ORIGIN]);
                assert.equal(result.resultHash, blockedOnly.result.resultHash);
                assert.equal(evidenceHashOf(result), evidenceHashOf(blockedOnly.result));
            });

            test("then it should change the evidence hash from a session that blocked nothing, so the sameness means something", async () => {
                const raw = unsafePlan([OPEN_CART]);
                const quiet = await runOnFakeSession(raw);
                const { result } = await runOnFakeSession(raw, {
                    session: sessionReading(() => FAILURES, {
                        blockedOrigins: () => [BLOCKED_ORIGIN],
                    }),
                });
                assert.notEqual(evidenceHashOf(result), evidenceHashOf(quiet.result));
            });
        });
    });

    describe("given a session whose read of blocked origins throws", () => {
        describe("and that could not connect to two origins", () => {
            describe("when the run ends", () => {
                test("then it should still log the connection failures", async () => {
                    const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        session: sessionReading(() => FAILURES, { blockedOrigins: throws }),
                    });
                    assert.deepEqual(failuresLoggedIn(events), FAILURES);
                });
            });
        });
    });

    describe("given a connection failure that names a person", () => {
        describe("when the run logs it", () => {
            test("then it should log the origin and message as the redactor leaves them", async () => {
                const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                    session: sessionReading(() => [FAILURE_NAMING_A_PERSON]),
                });
                const redactor = defaultRedactor();
                assert.deepEqual(failuresLoggedIn(events), [
                    {
                        origin: redactor.text(FAILURE_NAMING_A_PERSON.origin),
                        message: redactor.text(FAILURE_NAMING_A_PERSON.message),
                    },
                ]);
            });

            test("then it should leave the person out of the log", async () => {
                const { events } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                    session: sessionReading(() => [FAILURE_NAMING_A_PERSON]),
                });
                assert.equal(connectionFailedEvents(events).length, 1);
                assert.equal(JSON.stringify(events.read()).includes(PERSON), false);
            });
        });
    });

    describe("given a session that could not connect to two origins", () => {
        describe("and a log that fails when told so", () => {
            describe("when the run ends", () => {
                test("then it should give the verdict and hash of a session with no failures", async () => {
                    const raw = unsafePlan([OPEN_CART]);
                    const sound = await runOnFakeSession(raw);
                    const { result } = await runOnFakeSession(raw, {
                        session: sessionReading(() => FAILURES),
                        events: logFailingOnAConnectionFailure(),
                    });
                    assert.equal(result.state, "Passed");
                    assert.equal(result.resultHash, sound.result.resultHash);
                });
            });
        });
    });
});
