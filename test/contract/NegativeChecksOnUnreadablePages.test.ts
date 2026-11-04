// A check that an element is absent or hidden passes when nothing is on screen, so a page the run
// cannot read must never look like an empty page. These tests run real browsers: the tab's renderer
// is ended, the browser is ended or its socket is closed, a dialog holds the page, or the page's own
// DOM functions throw. The counter-examples keep the checks passing on a page that can be read.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test, type TestContext } from "node:test";
import type { DriverSession, OwnBrowserDriver } from "@revisum/driver-cdp";
import type { RunResult, SessionEnvironment, Target } from "@revisum/engine";
import { outcomes, stepMilliseconds } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, DriverAdapter } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    navigate,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { driverWith, sessionWith } from "#test-support/browser/WrappingSessions.ts";
import {
    capabilityDrivers,
    capabilityHarness,
    capabilityPlan,
    ownDriverFor,
    watchedDriver,
    type CapabilityHarness,
    type WatchedDriver,
} from "#test-support/capability-harness.ts";
import { endAtOnce, rendererProcesses } from "#test-support/process-tree.ts";
import { CRASH_READY_PATH, crashWhenRequested } from "#test-support/tab-crash.ts";
import { assertStepFailedWith } from "./AssertStepFailedWith.ts";
import {
    ANSWERED_DIALOG_PATH,
    BOX_READ_THROWS_PATH,
    NOTES_PATH,
    QUERY_THROWS_PATH,
    UNREADABLE_PAGES,
} from "./UnreadablePages.ts";

// Long enough for the test to find and end the renderer while the check waits, even where listing
// processes takes a second or more.
const CRASH_STEP_TIMEOUT_MILLISECONDS = 8000;
const CRASH_NOTICE_MILLISECONDS = 5000;
const CRASH_NOTICE_POLL_MILLISECONDS = 20;
// Where a check that gives up at once must end, against a step timeout of 8 seconds.
const AT_ONCE_MILLISECONDS = 4000;

const TARGET = BrowserTarget.Chrome;

const checkOf = (name: string, locator: JsonRecord, assertion: JsonRecord): JsonRecord => ({
    type: "expect",
    locator,
    assert: assertion,
    criterionId: `note.${name}`,
});

const NEGATIVE_CHECKS: readonly { readonly name: string; readonly assertion: JsonRecord }[] = [
    { name: "absent", assertion: { kind: "absent" } },
    { name: "hidden", assertion: { kind: "hidden" } },
    { name: "countEquals 0", assertion: { kind: "countEquals", value: 0 } },
];

const negativeCheck = (check: (typeof NEGATIVE_CHECKS)[number], locator: JsonRecord): JsonRecord =>
    checkOf(check.name.replace(" ", "-"), locator, check.assertion);

const CRASH_STATUS = testId("crash-status");
const DIALOG_STATUS = testId("dialog-status");
const START_REPORT = click(role("button", "Start the report"));
const REPORT_READY = textEquals(CRASH_STATUS, "Report ready", "crash.report-ready");

let waitingLong: CapabilityHarness;
let waitingBriefly: CapabilityHarness;

before(async () => {
    waitingLong = await capabilityHarness(CRASH_STEP_TIMEOUT_MILLISECONDS, UNREADABLE_PAGES);
    waitingBriefly = await capabilityHarness(undefined, UNREADABLE_PAGES);
});
after(async () => {
    await waitingLong.close();
    await waitingBriefly.close();
});

const driversWith = (watched: WatchedDriver) =>
    new Map([...capabilityDrivers(), [DriverAdapter.Cdp, watched.driver]]);

const runBriefly = async (steps: readonly unknown[]): Promise<RunResult> => {
    const plan = waitingBriefly.plan(capabilityPlan(TARGET, steps));
    return (await waitingBriefly.run(plan, TARGET)).result;
};

// The steps of a plan, with a tab whose renderer the test ends while the plan's second step waits.
async function runWithTabCrashWhileWaiting(steps: readonly unknown[]) {
    const watched = watchedDriver(ownDriverFor(TARGET));
    const crashed = crashWhenRequested(waitingLong, watched, CRASH_READY_PATH);
    const plan = waitingLong.plan(capabilityPlan(TARGET, steps));
    const { result } = await waitingLong.run(plan, TARGET, { drivers: driversWith(watched) });
    return { result, endedRenderers: await crashed };
}

// The steps of a plan, with whatever the test ends once the page signals, as the plan's second step
// waits. Resolves with whether the signal came.
async function runInterruptedWhileWaiting(
    steps: readonly unknown[],
    interrupt: (browserProcessId: number) => void,
) {
    const watched = watchedDriver(ownDriverFor(TARGET));
    let wasInterrupted = false;
    void Promise.all([watched.opened(), waitingLong.requested(CRASH_READY_PATH)]).then(
        ([browserProcessId]) => {
            interrupt(browserProcessId);
            wasInterrupted = true;
        },
    );
    const plan = waitingLong.plan(capabilityPlan(TARGET, steps));
    const { result } = await waitingLong.run(plan, TARGET, { drivers: driversWith(watched) });
    return { result, watched, wasInterrupted };
}

// Runs with the global WebSocket replaced by one that remembers its sockets, which is the only way
// a test can close the driver's connection and leave its browser running.
async function runWithSocketDroppedWhileWaiting(context: TestContext, steps: readonly unknown[]) {
    const sockets: WebSocket[] = [];
    class RememberedWebSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            sockets.push(this);
        }
    }
    context.mock.property(globalThis, "WebSocket", RememberedWebSocket);
    return runInterruptedWhileWaiting(steps, () => {
        for (const socket of sockets) {
            socket.close();
        }
    });
}

// A driver that ends the tab's renderer as the first check begins, and waits until the session has
// seen the crash, so the check runs on a tab already known to be dead.
function crashingBeforeFirstCheck(inner: OwnBrowserDriver) {
    const seen = { endedRenderers: 0, sawCrash: false };
    const crashOnce = async (session: DriverSession): Promise<void> => {
        const renderers = rendererProcesses(session.processId);
        for (const renderer of renderers) {
            endAtOnce(renderer.processId);
        }
        seen.endedRenderers = renderers.length;
        const deadline = Date.now() + CRASH_NOTICE_MILLISECONDS;
        while (!session.crashed() && Date.now() < deadline) {
            await pause(CRASH_NOTICE_POLL_MILLISECONDS);
        }
        seen.sawCrash = session.crashed();
    };
    const driver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            if (!opened.ok) {
                return opened;
            }
            const session = opened.value;
            let isCrashDone = false;
            const probe = async (
                ...read: Parameters<DriverSession["probe"]>
            ): ReturnType<DriverSession["probe"]> => {
                if (!isCrashDone) {
                    isCrashDone = true;
                    await crashOnce(session);
                }
                return session.probe(...read);
            };
            return { ok: true as const, value: sessionWith(session, { probe }) };
        },
    });
    return { driver, seen };
}

function assertSecondStepCrashed(result: RunResult, skippedSteps: readonly number[] = []): void {
    assert.deepEqual(
        { state: result.state, steps: outcomes(result) },
        {
            state: "Failed",
            steps: [
                [0, "passed", undefined],
                [1, "failed", "target-crashed"],
                ...skippedSteps.map((index) => [index, "skipped", undefined]),
            ],
        },
    );
}

function assertEveryStepPassed(result: RunResult): void {
    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
}

describe("Using a run in a real browser", () => {
    for (const check of NEGATIVE_CHECKS) {
        describe(`given a final ${check.name} check of an element on screen`, () => {
            describe("and the tab's renderer dies while the check waits", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with target-crashed", async () => {
                        const { result, endedRenderers } = await runWithTabCrashWhileWaiting([
                            navigate("/crash.html"),
                            negativeCheck(check, CRASH_STATUS),
                        ]);
                        assert.ok(endedRenderers > 0, "the test found a renderer to end");
                        assertSecondStepCrashed(result);
                    });
                });
            });

            describe("and the tab's renderer has died before the check begins", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with target-crashed", async () => {
                        const crashing = crashingBeforeFirstCheck(ownDriverFor(TARGET));
                        const plan = waitingLong.plan(
                            capabilityPlan(TARGET, [
                                navigate("/dialog.html"),
                                negativeCheck(check, DIALOG_STATUS),
                            ]),
                        );
                        const { result } = await waitingLong.run(plan, TARGET, {
                            drivers: new Map([
                                ...capabilityDrivers(),
                                [DriverAdapter.Cdp, crashing.driver],
                            ]),
                        });
                        assert.ok(crashing.seen.endedRenderers > 0, "a renderer was ended");
                        assert.ok(crashing.seen.sawCrash, "the session saw the crash");
                        assertSecondStepCrashed(result);
                    });
                });
            });

            describe("and the whole browser dies while the check waits", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with target-crashed", async () => {
                        const { result, wasInterrupted } = await runInterruptedWhileWaiting(
                            [navigate("/crash.html"), negativeCheck(check, CRASH_STATUS)],
                            endAtOnce,
                        );
                        assert.ok(wasInterrupted, "the test ended the browser");
                        assertSecondStepCrashed(result);
                    });
                });
            });

            describe("and the browser's socket drops while the check waits", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with target-crashed", async (context) => {
                        const { result, wasInterrupted } = await runWithSocketDroppedWhileWaiting(
                            context,
                            [navigate("/crash.html"), negativeCheck(check, CRASH_STATUS)],
                        );
                        assert.ok(wasInterrupted, "the test closed the socket");
                        assertSecondStepCrashed(result);
                    });
                });
            });

            describe("and a click has opened a confirm dialog that nothing answers", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with dialog-open, at once", async () => {
                        const plan = waitingLong.plan(
                            capabilityPlan(TARGET, [
                                navigate("/dialog.html"),
                                click(role("button", "Ask a question")),
                                negativeCheck(check, DIALOG_STATUS),
                            ]),
                        );
                        const { result } = await waitingLong.run(plan, TARGET);
                        assertStepFailedWith(result, 2, "dialog-open");
                        assert.ok(stepMilliseconds(result, 2) < AT_ONCE_MILLISECONDS);
                    });
                });
            });

            describe("and the page's querySelectorAll throws, so the element can't be found", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with page-unreadable, at the timeout", async () => {
                        const result = await runBriefly([
                            navigate(QUERY_THROWS_PATH),
                            negativeCheck(check, testId("shown-note")),
                        ]);
                        assertStepFailedWith(result, 1, "page-unreadable");
                        assert.ok(
                            stepMilliseconds(result, 1) >=
                                waitingBriefly.stepTimeoutMilliseconds / 2,
                        );
                    });
                });
            });

            describe("and the page's getBoundingClientRect throws, so the element can't be read", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with page-unreadable, at the timeout", async () => {
                        const result = await runBriefly([
                            navigate(BOX_READ_THROWS_PATH),
                            negativeCheck(check, testId("shown-note")),
                        ]);
                        assertStepFailedWith(result, 1, "page-unreadable");
                        assert.ok(
                            stepMilliseconds(result, 1) >=
                                waitingBriefly.stepTimeoutMilliseconds / 2,
                        );
                    });
                });
            });

            describe("and a healthy page that shows the element", () => {
                describe("when the run ends", () => {
                    test("then it should fail the check with assertion-failed", async () => {
                        const result = await runBriefly([
                            navigate(NOTES_PATH),
                            negativeCheck(check, testId("shown-note")),
                        ]);
                        assertStepFailedWith(result, 1, "assertion-failed");
                    });
                });
            });
        });

        describe(`given a final ${check.name} check of an element no page has`, () => {
            describe("and a healthy page", () => {
                describe("when the run ends", () => {
                    test("then it should pass", async () => {
                        const result = await runBriefly([
                            navigate(NOTES_PATH),
                            negativeCheck(check, testId("no-such-note")),
                        ]);
                        assertEveryStepPassed(result);
                    });
                });
            });
        });
    }

    describe("given a final hidden check of an element the page really hides", () => {
        describe("and a healthy page", () => {
            describe("when the run ends", () => {
                test("then it should pass", async () => {
                    const result = await runBriefly([
                        navigate(NOTES_PATH),
                        negativeCheck(
                            { name: "hidden", assertion: { kind: "hidden" } },
                            testId("hidden-note"),
                        ),
                    ]);
                    assertEveryStepPassed(result);
                });
            });
        });
    });

    describe("given a confirm dialog the plan answers", () => {
        const answeredDialog = [
            navigate(ANSWERED_DIALOG_PATH),
            click(role("button", "Tidy the notes")),
            { type: "dialog", action: "accept", expectText: "Tidy the notes?" },
        ];

        describe("and accepting it removes one element and hides another", () => {
            describe("when absent, countEquals 0 and hidden run on those elements", () => {
                test("then it should pass all of them", async () => {
                    const result = await runBriefly([
                        ...answeredDialog,
                        checkOf("removed-absent", testId("removed-note"), { kind: "absent" }),
                        checkOf("removed-count", testId("removed-note"), {
                            kind: "countEquals",
                            value: 0,
                        }),
                        checkOf("really-hidden", testId("hidden-note"), { kind: "hidden" }),
                    ]);
                    assertEveryStepPassed(result);
                });
            });
        });
    });

    describe("given a step other than a negative check", () => {
        describe("and the whole browser dies while a click waits", () => {
            describe("when the run ends", () => {
                test("then it should fail the click with target-crashed, not not-found", async () => {
                    const { result, wasInterrupted } = await runInterruptedWhileWaiting(
                        [navigate("/crash.html"), START_REPORT, REPORT_READY],
                        endAtOnce,
                    );
                    assert.ok(wasInterrupted, "the test ended the browser");
                    assertSecondStepCrashed(result, [2]);
                });
            });
        });

        describe("and the whole browser dies while a text check waits", () => {
            describe("when the run ends", () => {
                test("then it should fail the check with target-crashed, not not-found", async () => {
                    const { result, wasInterrupted } = await runInterruptedWhileWaiting(
                        [navigate("/crash.html"), REPORT_READY],
                        endAtOnce,
                    );
                    assert.ok(wasInterrupted, "the test ended the browser");
                    assertSecondStepCrashed(result);
                });
            });
        });

        describe("and the browser's socket drops while a click waits", () => {
            describe("when the run ends", () => {
                test("then it should fail the click with target-crashed, not not-found", async (context) => {
                    const { result, wasInterrupted } = await runWithSocketDroppedWhileWaiting(
                        context,
                        [navigate("/crash.html"), START_REPORT, REPORT_READY],
                    );
                    assert.ok(wasInterrupted, "the test closed the socket");
                    assertSecondStepCrashed(result, [2]);
                });
            });
        });

        describe("and the browser's socket drops while a text check waits", () => {
            describe("when the run ends", () => {
                test("then it should fail the check with target-crashed and end every browser process", async (context) => {
                    const { result, wasInterrupted, watched } =
                        await runWithSocketDroppedWhileWaiting(context, [
                            navigate("/crash.html"),
                            REPORT_READY,
                        ]);
                    assert.ok(wasInterrupted, "the test closed the socket");
                    const session = watched.sessions[0];
                    assert.ok(session !== undefined);
                    assert.ok(session.processesBeforeClose.length > 0, "the browser was alive");
                    assert.deepEqual(session.stillRunningAfterClose, []);
                    assertSecondStepCrashed(result);
                });
            });
        });
    });
});
