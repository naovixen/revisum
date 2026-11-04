// A check that reads something must not pass, or give up late, when the run cannot read the page:
// a dialog holds it, its script holds its thread, its frame is gone, its renderer or browser has died.
// A page's own DOM functions that throw are no such case, since a read does not call them.
// These tests run real browsers.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { stepMilliseconds } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    navigate,
    role,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import {
    capabilityHarness,
    capabilityPlan,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import { endAtOnce, rendererProcesses } from "#test-support/process-tree.ts";
import { assertStepFailedWith } from "./AssertStepFailedWith.ts";
import {
    BOX_READ_THROWS_PATH,
    NOTES_PATH,
    QUERY_THROWS_PATH,
    REMOVABLE_FRAME_PATH,
    SLOW_LOAD_PATH,
    THREAD_HELD_PATH,
    UNREADABLE_PAGES,
} from "./UnreadablePages.ts";

const LONG_STEP_TIMEOUT_MILLISECONDS = 8000;
const CRASH_NOTICE_MILLISECONDS = 5000;
const CRASH_NOTICE_POLL_MILLISECONDS = 20;
// Where a step that gives up at once must end, against a step timeout of 8 seconds.
const AT_ONCE_MILLISECONDS = 4000;

const TARGET = BrowserTarget.Chrome;
const DIALOG_STATUS = testId("dialog-status");

let waitingLong: CapabilityHarness;
let waitingBriefly: CapabilityHarness;

before(async () => {
    waitingLong = await capabilityHarness(LONG_STEP_TIMEOUT_MILLISECONDS, UNREADABLE_PAGES);
    waitingBriefly = await capabilityHarness(undefined, UNREADABLE_PAGES);
});
after(async () => {
    await waitingLong.close();
    await waitingBriefly.close();
});

const runBriefly = async (steps: readonly unknown[]) => {
    const plan = waitingBriefly.plan(capabilityPlan(TARGET, steps));
    return (await waitingBriefly.run(plan, TARGET)).result;
};

const checkOf = (name: string, locator: JsonRecord, assertion: JsonRecord): JsonRecord => ({
    type: "expect",
    locator,
    assert: assertion,
    criterionId: `note.${name}`,
});

async function waitUntilCrashNoticed(session: DriverSession): Promise<void> {
    const deadline = Date.now() + CRASH_NOTICE_MILLISECONDS;
    while (!session.crashed() && Date.now() < deadline) {
        await pause(CRASH_NOTICE_POLL_MILLISECONDS);
    }
}

describe("Using a run in a real browser", () => {
    describe("given a visible check of an element on screen", () => {
        describe("and a click has opened a confirm dialog that nothing answers", () => {
            describe("when the run ends", () => {
                test("then it should fail the check with dialog-open, at once", async () => {
                    const plan = waitingLong.plan(
                        capabilityPlan(TARGET, [
                            navigate("/dialog.html"),
                            click(role("button", "Ask a question")),
                            visible(DIALOG_STATUS, "dialog.status-shown"),
                        ]),
                    );
                    const { result } = await waitingLong.run(plan, TARGET);
                    assertStepFailedWith(result, 2, "dialog-open");
                    assert.ok(stepMilliseconds(result, 2) < AT_ONCE_MILLISECONDS);
                });
            });
        });

        describe("and the page's querySelectorAll throws, which the check does not call", () => {
            describe("when the run ends", () => {
                test("then it should pass the check, as the element is there", async () => {
                    const result = await runBriefly([
                        navigate(QUERY_THROWS_PATH),
                        visible(testId("shown-note"), "note.shown"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });

        describe("and the page's getBoundingClientRect throws, which the check does not call", () => {
            describe("when the run ends", () => {
                test("then it should pass the check, as the element is there", async () => {
                    const result = await runBriefly([
                        navigate(BOX_READ_THROWS_PATH),
                        visible(testId("shown-note"), "note.shown"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });

        describe("and the page's script never lets go of its thread", () => {
            describe("when the run ends", () => {
                test("then it should fail the check with page-unreadable", async () => {
                    const result = await runBriefly([
                        navigate(THREAD_HELD_PATH),
                        visible(testId("shown-note"), "note.shown"),
                    ]);
                    assertStepFailedWith(result, 1, "page-unreadable");
                });
            });
        });
    });

    describe("given a page that is still loading", () => {
        describe("and its renderer dies while navigate waits for it", () => {
            describe("when navigate returns", () => {
                test("then it should fail with target-crashed, long before the step timeout", async () => {
                    const session = await waitingLong.openOwn(TARGET);
                    try {
                        const asked = waitingLong.requested(SLOW_LOAD_PATH);
                        const startedAt = Date.now();
                        const navigating = session.navigate(waitingLong.url(SLOW_LOAD_PATH));
                        await asked;
                        const deadline = Date.now() + CRASH_NOTICE_MILLISECONDS;
                        while (!session.crashed() && Date.now() < deadline) {
                            for (const renderer of rendererProcesses(session.processId)) {
                                endAtOnce(renderer.processId);
                            }
                            await pause(CRASH_NOTICE_POLL_MILLISECONDS);
                        }
                        const navigated = await navigating;
                        assert.ok(session.crashed(), "the test crashed the page");
                        assert.equal(
                            navigated.ok ? "passed" : navigated.error.code,
                            "target-crashed",
                        );
                        assert.ok(Date.now() - startedAt < AT_ONCE_MILLISECONDS);
                    } finally {
                        await session.close();
                    }
                });
            });
        });
    });

    describe("given a browser that has died", () => {
        describe("when a new tab is opened on its session", () => {
            test("then it should fail with target-crashed", async () => {
                const session = await waitingLong.openOwn(TARGET);
                try {
                    assert.ok((await session.navigate(waitingLong.url(NOTES_PATH))).ok);
                    endAtOnce(session.processId);
                    await waitUntilCrashNoticed(session);
                    assert.ok(session.crashed(), "the session saw the browser die");
                    const opened = await session.newTab(waitingLong.url(NOTES_PATH));
                    assert.equal(opened.ok ? "opened" : opened.error.code, "target-crashed");
                } finally {
                    await session.close();
                }
            });
        });
    });

    describe("given an absent check inside a frame", () => {
        describe("and the page removes that frame before the check runs", () => {
            describe("when the run ends", () => {
                test("then it should fail the check with page-unreadable", async () => {
                    const result = await runBriefly([
                        navigate(REMOVABLE_FRAME_PATH),
                        {
                            type: "frame",
                            locator: testId("removable-frame"),
                            steps: [
                                click(role("button", "Remove this frame")),
                                checkOf("frame-absent", testId("no-such-note"), {
                                    kind: "absent",
                                }),
                            ],
                        },
                    ]);
                    assertStepFailedWith(result, 1, "page-unreadable");
                });
            });
        });
    });
});
