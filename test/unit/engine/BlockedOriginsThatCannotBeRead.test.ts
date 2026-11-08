// A run's result claims what its egress refused, and is hashed with that claim in it. When the list
// can't be read, an empty one would say nothing was refused, so the run gives no verdict at all. The
// engine reads the list the same way for a host run and an isolated run.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeRefusedOrigins } from "@revisum/contracts";
import {
    egressThroughExistingProxy,
    type RefusalReader,
    type SessionEgress,
} from "@revisum/driver-cdp";
import { failure, success, type RunEventSink, type Session } from "@revisum/engine";
import {
    fakeSessionOnOrders,
    runOnFakeSession,
    stepSummaries,
    fakeNetwork,
} from "./RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";
import { fakeRunEventSinkFailingOn } from "#test-support/fakes/FakeRunEventSink.ts";
import { closedSession, sessionRecords } from "#test-support/fakes/FakeSession.ts";

const REFUSALS_UNREAD = "egress-unread";
const BROKEN = "the proxy's refusals could not be read: connect ECONNREFUSED";
const PROXY_SERVER = "http://proxy.test:3128";
const REFUSED_EARLIER = "earlier.example.test:443";
const REFUSED_IN_THE_RUN = "blocked.example.test:443";

const throws = (): never => {
    throw new Error(BROKEN);
};

const refusalsUnreadable = () => failure(BROKEN);

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

const RUN_KINDS: readonly { readonly name: string; readonly isProxyingLoopback: boolean }[] = [
    { name: "an isolated run", isProxyingLoopback: false },
    { name: "a host run", isProxyingLoopback: true },
];

const fakeEgress = (
    isProxyingLoopback: boolean,
    refusedOrigins: SessionEgress["refusedOrigins"],
): SessionEgress => ({
    proxy: { server: PROXY_SERVER, includeLoopback: isProxyingLoopback },
    refusedOrigins,
    connectionFailures: () => [],
    close: () => Promise.resolve(),
});

// The session's records as the driver gives them: what the egress refused, or why it could not say.
function recordsOfEgress(egress: SessionEgress) {
    const refused = egress.refusedOrigins();
    return sessionRecords({
        blockedOrigins: refused.ok ? success(mergeRefusedOrigins([], refused.value)) : refused,
    });
}

// A session that treats its egress as the driver does: closes it, and only then reads its refusals.
const sessionOver = (egress: SessionEgress, changes: Partial<Session> = {}): Session =>
    fakeSessionOnOrders({
        recordsSoFar: () => recordsOfEgress(egress),
        close: async () => {
            await egress.close();
            return { ...recordsOfEgress(egress), closeFailure: null };
        },
        ...changes,
    });

// The real egress of an isolated run, reading the refusals once as it opens and once as it closes.
function egressReadingInTurn(
    atOpen: Awaited<ReturnType<RefusalReader>>,
    atClose: Awaited<ReturnType<RefusalReader>>,
): Promise<SessionEgress> {
    const answers = [atOpen, atClose].values();
    const read: RefusalReader = () => Promise.resolve(answers.next().value ?? atClose);
    return egressThroughExistingProxy(PROXY_SERVER, read)([]);
}

// Every code the result holds, so these tests fix what it says and not where it keeps it.
function codesIn(value: unknown): readonly string[] {
    if (typeof value !== "object" || value === null) {
        return [];
    }
    return Object.entries(value).flatMap(([name, nested]: [string, unknown]) =>
        name === "code" && typeof nested === "string" ? [nested] : codesIn(nested),
    );
}

const lastRunState = (events: RunEventSink): unknown =>
    events
        .read()
        .filter((event) => event.kind === "run.state")
        .at(-1)?.state;

const FINAL_STATES: readonly unknown[] = ["Passed", "Failed", "Errored", "Denied"];

// A log that works until it is told how the run ended.
const logFailingAtTheEnd = (): RunEventSink =>
    fakeRunEventSinkFailingOn(
        (event) => event.kind === "run.state" && FINAL_STATES.includes(event.state),
    );

describe("Using the run", () => {
    for (const verdict of VERDICTS) {
        const raw = unsafePlan(verdict.steps);

        for (const { name, isProxyingLoopback } of RUN_KINDS) {
            describe(`given ${verdict.name}`, () => {
                describe(`and ${name} whose egress can't say what it refused`, () => {
                    const session = (changes: Partial<Session> = {}): Session =>
                        sessionOver(fakeEgress(isProxyingLoopback, refusalsUnreadable), changes);

                    describe("when the run ends", () => {
                        test("then it should end Errored", async () => {
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.equal(result.state, "Errored");
                        });

                        test("then it should give the code saying the refusals went unread", async () => {
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.ok(
                                codesIn(result).includes(REFUSALS_UNREAD),
                                JSON.stringify(result),
                            );
                        });

                        test("then it should log the same end state", async () => {
                            const { events } = await runOnFakeSession(raw, { session: session() });
                            assert.equal(lastRunState(events), "Errored");
                        });

                        test("then it should keep each step's own outcome", async () => {
                            const sound = await runOnFakeSession(raw);
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.deepEqual(stepSummaries(result), stepSummaries(sound.result));
                        });

                        test("then it should keep the failure's text out of the result", async () => {
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.equal(JSON.stringify(result).includes(BROKEN), false);
                        });

                        test("then it should give the failure's text to the log", async () => {
                            const { events } = await runOnFakeSession(raw, { session: session() });
                            const details = events.read().map((event) => event.detail);
                            assert.ok(details.includes(BROKEN), JSON.stringify(details));
                        });

                        test("then it should close the session once", async (context) => {
                            const close = context.mock.fn(() => Promise.resolve(closedSession()));
                            await runOnFakeSession(raw, { session: session({ close }) });
                            assert.equal(close.mock.callCount(), 1);
                        });
                    });

                    describe("and whose stub answers and close fail too", () => {
                        describe("when the run ends", () => {
                            test("then it should end Errored with the code", async () => {
                                const { result } = await runOnFakeSession(raw, {
                                    session: session({
                                        network: { ...fakeNetwork(), stubAnswers: throws },
                                        close: () => Promise.reject(new Error(BROKEN)),
                                    }),
                                });
                                assert.equal(result.state, "Errored");
                                assert.ok(
                                    codesIn(result).includes(REFUSALS_UNREAD),
                                    JSON.stringify(result),
                                );
                            });
                        });
                    });

                    describe("and a log that fails when told how the run ended", () => {
                        describe("when the run ends", () => {
                            test("then it should end Errored with the code", async () => {
                                const { result } = await runOnFakeSession(raw, {
                                    session: session(),
                                    events: logFailingAtTheEnd(),
                                });
                                assert.equal(result.state, "Errored");
                                assert.ok(
                                    codesIn(result).includes(REFUSALS_UNREAD),
                                    JSON.stringify(result),
                                );
                            });
                        });
                    });
                });

                describe(`and ${name} whose egress says what it refused`, () => {
                    const session = (): Session =>
                        sessionOver(
                            fakeEgress(isProxyingLoopback, () => success([REFUSED_IN_THE_RUN])),
                        );

                    describe("when the run ends", () => {
                        test("then it should keep the verdict and list the refusal", async () => {
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.equal(result.state, verdict.state);
                            assert.deepEqual(result.blockedOrigins, [REFUSED_IN_THE_RUN]);
                        });

                        test("then it should give no code saying the refusals went unread", async () => {
                            const { result } = await runOnFakeSession(raw, { session: session() });
                            assert.equal(codesIn(result).includes(REFUSALS_UNREAD), false);
                        });
                    });
                });

                describe(`and ${name} whose egress refused nothing`, () => {
                    describe("when the run ends", () => {
                        test("then it should keep the verdict with an empty list", async () => {
                            const { result } = await runOnFakeSession(raw, {
                                session: sessionOver(
                                    fakeEgress(isProxyingLoopback, () => success([])),
                                ),
                            });
                            assert.equal(result.state, verdict.state);
                            assert.deepEqual(result.blockedOrigins, []);
                            assert.equal(codesIn(result).includes(REFUSALS_UNREAD), false);
                        });
                    });
                });
            });
        }

        describe(`given ${verdict.name}`, () => {
            describe("and an isolated run's real egress that can't read the proxy at close", () => {
                describe("when its refusals are read", () => {
                    test("then it should answer with why, and not throw", async () => {
                        const egress = await egressReadingInTurn(
                            success([REFUSED_EARLIER]),
                            failure(BROKEN),
                        );
                        await egress.close();
                        assert.deepEqual(egress.refusedOrigins(), failure(BROKEN));
                    });
                });

                describe("when the run ends", () => {
                    test("then it should end Errored with the code", async () => {
                        const egress = await egressReadingInTurn(
                            success([REFUSED_EARLIER]),
                            failure(BROKEN),
                        );
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionOver(egress),
                        });
                        assert.equal(result.state, "Errored");
                        assert.ok(
                            codesIn(result).includes(REFUSALS_UNREAD),
                            JSON.stringify(result),
                        );
                    });
                });
            });

            describe("and an isolated run's real egress that can read the proxy at both ends", () => {
                describe("when the run ends", () => {
                    test("then it should keep the verdict and list only the run's own refusal", async () => {
                        const egress = await egressReadingInTurn(
                            success([REFUSED_EARLIER]),
                            success([REFUSED_EARLIER, REFUSED_IN_THE_RUN]),
                        );
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionOver(egress),
                        });
                        assert.equal(result.state, verdict.state);
                        assert.deepEqual(result.blockedOrigins, [REFUSED_IN_THE_RUN]);
                    });
                });
            });

            describe("and an isolated run's real egress that can read the proxy only at close", () => {
                describe("when the run ends", () => {
                    test("then it should keep the verdict and list everything the proxy refused", async () => {
                        const egress = await egressReadingInTurn(
                            failure(BROKEN),
                            success([REFUSED_EARLIER, REFUSED_IN_THE_RUN]),
                        );
                        const { result } = await runOnFakeSession(raw, {
                            session: sessionOver(egress),
                        });
                        assert.equal(result.state, verdict.state);
                        assert.deepEqual(result.blockedOrigins, [
                            REFUSED_IN_THE_RUN,
                            REFUSED_EARLIER,
                        ]);
                    });
                });
            });
        });
    }
});
