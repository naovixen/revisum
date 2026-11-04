// A run's verdict when the browser refuses a decision on a request: a request it would not let go on
// stays held, so nothing after it says anything about the app. Its reason goes to the log alone. A
// verdict the run already reached stands, and so does one when all that failed is a clean-up at close.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
    outcomes,
    type BrowserRun,
    type BrowserRunOptions,
} from "#test-support/browser/BrowserHarness.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import type { CdpRelay, ReplyTampering } from "#test-support/browser/CdpRelay.ts";
import {
    click,
    navigate,
    testId,
    textEquals,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { startRelayedDriver } from "#test-support/browser/RelayedDriver.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 2000;
// A page's request reaches the driver in milliseconds, so this is only for one that never comes.
const REFUSAL_DEADLINE_MILLISECONDS = 10_000;
const WHY_THE_BROWSER_REFUSED = "Invalid parameters: this decision was refused";
const PAGE_THAT_GIVES_UP_ON_DATA = "/gives-up-on-data.html";
const DATA_GIVEN_UP_ON = "/data-given-up-on.json";
const PAGE_READY = "/ready.html";
const DATA_ASKED_FOR_AFTER_THE_LAST_STEP = "/late-data.json";
const ADAPTER_ERROR = "adapter-error";
const SESSION_CLOSE_FAILED = "session-close-failed";
const CANARY = "zqrefusalcanary";
const OTHER_CANARY = "zqothercanary";
const ADDRESS = "zqholder@example.test";

const READY = testId("ready");
const SAVE = testId("save");
const DELETE_ACCOUNT = testId("delete-account");
const READY_IS_SHOWN = visible(READY, "refusals.ready-shown");
const STEPS_THAT_KEEP_OBJECTS = [navigate(PAGE_READY), click(SAVE), READY_IS_SHOWN];

const html: (body: string) => FixtureRoute = (body) => () => ({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>${body}</body></html>`,
});

const READY_MARKUP = `<p data-testid="ready">Ready</p>`;

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE_THAT_GIVES_UP_ON_DATA,
        html(
            `${READY_MARKUP}<script>fetch("${DATA_GIVEN_UP_ON}").catch(() => undefined);</script>`,
        ),
    ],
    [
        PAGE_READY,
        html(`${READY_MARKUP}
          <button type="button" data-testid="save">Save</button>
          <button type="button" data-testid="delete-account">Delete account</button>`),
    ],
]);

type RelayedRun = { readonly ran: BrowserRun; readonly relay: CdpRelay };

const runThroughRelay = async (
    harness: CapabilityHarness,
    steps: readonly JsonRecord[],
    tampering: ReplyTampering,
    options: BrowserRunOptions = {},
): Promise<RelayedRun> => {
    const { driver, relay } = await startRelayedDriver();
    relay.tamperWith(tampering);
    try {
        const ran = await harness.runSteps(TARGET, steps, {
            ...options,
            drivers: new Map([[ADAPTER_OF_TARGET[TARGET], driver]]),
        });
        return { ran, relay };
    } finally {
        await relay.close();
    }
};

const refusingDataGivenUpOn = (reason: string): ReplyTampering => ({
    method: "Fetch.continueRequest",
    applies: ({ pausedUrl }) => pausedUrl?.endsWith(DATA_GIVEN_UP_ON) ?? false,
    change: { refusal: reason },
});

// Has the page ask for data once the last step has ended, and holds the session open until the refusal
// is on its way back. The harness reads the page next, and that answer comes back after the refusal
// on the same connection, so the driver has heard it before the session closes.
const refusalAfterTheLastStep = (
    reason: string,
): { readonly tampering: ReplyTampering; readonly options: BrowserRunOptions } => {
    const refused = Promise.withResolvers<void>();
    return {
        tampering: {
            method: "Fetch.continueRequest",
            applies: ({ pausedUrl }) => {
                const isLateData = pausedUrl?.endsWith(DATA_ASKED_FOR_AFTER_THE_LAST_STEP) ?? false;
                if (isLateData) {
                    refused.resolve();
                }
                return isLateData;
            },
            change: { refusal: reason },
        },
        options: {
            read: [],
            beforePageRead: async (session) => {
                assert.ok(session.runScript !== undefined, "the driver runs scripts");
                await session.runScript({
                    source: `function () { fetch("${DATA_ASKED_FOR_AFTER_THE_LAST_STEP}").catch(() => undefined); return "asked"; }`,
                    arguments: {},
                    timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                    maximumResultBytes: 1000,
                });
                const deadline = setTimeout(() => {
                    refused.reject(
                        new Error(
                            `the page never asked for ${DATA_ASKED_FOR_AFTER_THE_LAST_STEP} within ${REFUSAL_DEADLINE_MILLISECONDS} ms`,
                        ),
                    );
                }, REFUSAL_DEADLINE_MILLISECONDS);
                try {
                    await refused.promise;
                } finally {
                    clearTimeout(deadline);
                }
            },
        },
    };
};

const failuresLogged = (ran: BrowserRun, code: string): readonly string[] =>
    ran.events
        .read()
        .filter((event) => event.kind === "step.end" && event.code === code)
        .map((event) => event.detail ?? "");

describe("Using a run in a real browser", () => {
    let harness: CapabilityHarness;

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });

    describe("given the browser refuses a decision after the last step has ended", () => {
        const runRefusedAtTheEnd = async (steps: readonly JsonRecord[]): Promise<BrowserRun> => {
            const { tampering, options } = refusalAfterTheLastStep(WHY_THE_BROWSER_REFUSED);
            const { ran, relay } = await runThroughRelay(harness, steps, tampering, options);
            // A run keeps its result whatever goes wrong as its session closes, so what stopped the
            // late request from being refused is found in the log, and named here.
            assert.deepEqual(failuresLogged(ran, SESSION_CLOSE_FAILED), []);
            assert.equal(relay.timesTampered(), 1, "the decision was refused");
            assert.match(
                failuresLogged(ran, ADAPTER_ERROR).join(),
                /this decision was refused/,
                "the log says why",
            );
            return ran;
        };

        describe("and every step had passed", () => {
            describe("when the run ends", () => {
                test("then it should end Errored, with the last step marked adapter-error", async () => {
                    const { result } = await runRefusedAtTheEnd([
                        navigate(PAGE_READY),
                        READY_IS_SHOWN,
                    ]);
                    assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                    assert.deepEqual(outcomes(result), [
                        [0, "passed", undefined],
                        [1, "failed", ADAPTER_ERROR],
                    ]);
                });
            });
        });

        describe("and a check had already failed", () => {
            describe("when the run ends", () => {
                test("then it should stay Failed, with the check's own code", async () => {
                    const { result } = await runRefusedAtTheEnd([
                        navigate(PAGE_READY),
                        textEquals(READY, "Something else", "refusals.wrong-text"),
                    ]);
                    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                    assert.deepEqual(outcomes(result), [
                        [0, "passed", undefined],
                        [1, "failed", "assertion-failed"],
                    ]);
                });
            });
        });

        describe("and the guard had already denied an action", () => {
            describe("when the run ends", () => {
                test("then it should stay Denied, with the denial it had", async () => {
                    const { result } = await runRefusedAtTheEnd([
                        navigate(PAGE_READY),
                        click(DELETE_ACCOUNT),
                        READY_IS_SHOWN,
                    ]);
                    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                    assert.equal(result.denial?.rule, "irreversible-action");
                    assert.deepEqual(outcomes(result), [
                        [0, "passed", undefined],
                        [1, "failed", "policy-denied"],
                        [2, "skipped", undefined],
                    ]);
                });
            });
        });
    });

    for (const reason of [
        "Invalid InterceptionId.",
        "Session with given id not found.",
        "connection closed",
    ]) {
        describe(`given the browser answers a decision with "${reason}"`, () => {
            describe("when a plan loads a page that gave up on the request", () => {
                test("then it should pass, with nothing logged as refused", async () => {
                    const { ran, relay } = await runThroughRelay(
                        harness,
                        [navigate(PAGE_THAT_GIVES_UP_ON_DATA), READY_IS_SHOWN],
                        refusingDataGivenUpOn(reason),
                    );
                    assert.equal(relay.timesTampered(), 1);
                    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                    assert.deepEqual(failuresLogged(ran, ADAPTER_ERROR), []);
                });
            });
        });
    }

    // Each is close to an answer that means nothing is held, and says something else.
    for (const reason of [
        "Fetch domain is not enabled",
        "Invalid InterceptionId",
        "Invalid InterceptionId. Try again",
        "connection closed by the browser",
    ]) {
        describe(`given the browser answers a decision with "${reason}"`, () => {
            describe("when a plan loads a page that gave up on the request", () => {
                test("then it should end Errored, with the step marked adapter-error", async () => {
                    const { ran, relay } = await runThroughRelay(
                        harness,
                        [navigate(PAGE_THAT_GIVES_UP_ON_DATA), READY_IS_SHOWN],
                        refusingDataGivenUpOn(reason),
                    );
                    assert.equal(relay.timesTampered(), 1);
                    assert.equal(ran.result.state, "Errored", JSON.stringify(ran.result.steps));
                    assert.deepEqual(outcomes(ran.result), [
                        [0, "failed", ADAPTER_ERROR],
                        [1, "skipped", undefined],
                    ]);
                });
            });
        });
    }

    describe("given the browser's reason for a refusal holds text of its own", () => {
        const runRefusedFor = async (reason: string): Promise<BrowserRun> => {
            const { ran } = await runThroughRelay(
                harness,
                [navigate(PAGE_THAT_GIVES_UP_ON_DATA), READY_IS_SHOWN],
                refusingDataGivenUpOn(reason),
            );
            return ran;
        };

        describe("when the run ends", () => {
            test("then it should keep only the code in the step's result", async () => {
                const { result } = await runRefusedFor(CANARY);
                assert.deepEqual(result.steps[0], {
                    index: 0,
                    type: "navigate",
                    outcome: "failed",
                    code: ADAPTER_ERROR,
                });
            });

            test("then it should keep the reason out of the result and the audit log", async () => {
                const { result, audit } = await runRefusedFor(CANARY);
                assert.equal(result.state, "Errored");
                assert.ok(!JSON.stringify(result).includes(CANARY), "the result holds no reason");
                assert.ok(!JSON.stringify(audit.recorded).includes(CANARY));
            });

            test("then it should write the reason to the log, as a step's failed end", async () => {
                const { events } = await runRefusedFor(CANARY);
                const naming = events
                    .read()
                    .filter((event) => JSON.stringify(event).includes(CANARY));
                assert.deepEqual(
                    naming.map(({ kind, code }) => ({ kind, code })),
                    [{ kind: "step.end", code: ADAPTER_ERROR }],
                );
            });

            test("then it should give the same hashes whatever the reason says", async () => {
                const first = await runRefusedFor(CANARY);
                const second = await runRefusedFor(OTHER_CANARY);
                assert.equal(first.result.resultHash, second.result.resultHash);
                assert.equal(first.result.evidenceHash, second.result.evidenceHash);
            });
        });

        describe("and the reason holds an email address", () => {
            describe("when the run ends", () => {
                test("then it should log the reason with the address redacted", async () => {
                    const ran = await runRefusedFor(`${CANARY} for ${ADDRESS}`);
                    const logged = failuresLogged(ran, ADAPTER_ERROR).join();
                    assert.match(logged, /zqrefusalcanary/);
                    assert.ok(!logged.includes(ADDRESS), logged);
                });
            });
        });
    });

    describe("given the browser refuses to release an object the driver kept", () => {
        describe("and says something other than that the object has gone", () => {
            describe("when the run ends", () => {
                test("then it should report it at close, with the verdict unchanged", async () => {
                    const { ran, relay } = await runThroughRelay(harness, STEPS_THAT_KEEP_OBJECTS, {
                        method: "Runtime.releaseObject",
                        change: { refusal: "Internal error: the release was refused" },
                    });
                    assert.ok(relay.timesTampered() > 0, "a release was refused");
                    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                    assert.match(
                        failuresLogged(ran, SESSION_CLOSE_FAILED).join(),
                        /a kept object could not be released.*the release was refused/,
                    );
                });
            });
        });

        for (const reason of [
            "Could not find object with given id",
            "Cannot find context with specified id",
            "Execution context was destroyed.",
            "Inspected target navigated or closed",
            "Session with given id not found.",
        ]) {
            describe(`and says "${reason}"`, () => {
                describe("when the run ends", () => {
                    test("then it should report nothing at close", async () => {
                        const { ran, relay } = await runThroughRelay(
                            harness,
                            STEPS_THAT_KEEP_OBJECTS,
                            {
                                method: "Runtime.releaseObject",
                                change: { refusal: reason },
                            },
                        );
                        assert.ok(relay.timesTampered() > 0, "a release was refused");
                        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                        assert.deepEqual(failuresLogged(ran, SESSION_CLOSE_FAILED), []);
                    });
                });
            });
        }
    });
});
