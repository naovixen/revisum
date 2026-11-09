// A click or a key press starts a navigation to a server that takes its time to answer, or never
// does. The step that started it must give up at its timeout, rather than hold the run for as long
// as the server holds its answer or pass and leave the next check a page it cannot read: it is the
// step whose effect has not arrived. This holds for every way of starting one, on a browser's first
// page as on a later one, and for a navigate step whose page moves on by itself as it loads. A page
// that only holds its own thread has arrived, so its navigate passes and the next check finds it
// unreadable.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { driversOnFreshBrowsers } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import {
    click,
    label,
    navigate,
    role,
    testId,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { TARGET, htmlPage, routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const HOLD_MILLISECONDS = 40_000;
const STEP_TIMEOUT_MILLISECONDS = 4_000;
// A click that really stopped at the timeout: the click's own waits add a little, but far less than
// another timeout, and far less than the server's hold.
const LONGEST_CLICK_MILLISECONDS = 2 * STEP_TIMEOUT_MILLISECONDS;

const LINK = "Follow the link";
const SCRIPTED_BUTTON = "Go by script";
const FORM_BUTTON = "Go by form";
const SEARCH_FIELD = "Search";

const NEVER_SHOWN_CHECK: JsonRecord = {
    type: "expect",
    locator: testId("never-shown"),
    assert: { kind: "absent" },
    criterionId: "held.page-read",
};

const CLICKS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a link", step: click(role("link", LINK)) },
    { name: "a button whose script moves the page", step: click(role("button", SCRIPTED_BUTTON)) },
];

const FORM_SUBMISSIONS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a click on a form's button", step: click(role("button", FORM_BUTTON)) },
    {
        name: "an Enter press",
        step: { type: "press", locator: label(SEARCH_FIELD), key: "Enter" },
    },
];

const CLICK_STEP = 1;

const REDIRECT_HELD_PATH = "/redirect-held.html";
const THREAD_HELD_PATH = "/thread-held.html";
const NAVIGATE_STEP = 0;
// The load is quick here, so a navigate that stopped at the timeout ends well inside two of them.
const LONGEST_NAVIGATE_MILLISECONDS = 2 * STEP_TIMEOUT_MILLISECONDS;

const BROWSERS_OF_A_RUN = [
    { name: "a shared browser", runOptions: () => ({}) },
    {
        name: "a browser launched for the run",
        runOptions: () => ({ drivers: driversOnFreshBrowsers([TARGET]) }),
    },
];

let harness: BrowserHarness;
let heldServer: Server;
const holds = new Set<NodeJS.Timeout>();

before(async () => {
    heldServer = createServer((request, response) => {
        const hold = setTimeout(() => response.socket?.destroy(), HOLD_MILLISECONDS);
        holds.add(hold);
    });
    await new Promise<void>((resolve) => heldServer.listen(0, "127.0.0.1", resolve));
    const heldOrigin = `http://127.0.0.1:${(heldServer.address() as AddressInfo).port}`;
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        otherOrigins: [heldOrigin],
        routes: new Map([
            [
                "/start.html",
                htmlPage(`
                  <a href="${heldOrigin}/by-link">${LINK}</a>
                  <button type="button" onclick="location.href='${heldOrigin}/by-script'">${SCRIPTED_BUTTON}</button>
                  <form action="${heldOrigin}/by-form"><button>${FORM_BUTTON}</button></form>
                  <form action="${heldOrigin}/by-enter"><label>${SEARCH_FIELD}<input name="q"></label></form>`),
            ],
            [
                REDIRECT_HELD_PATH,
                htmlPage(
                    `<script>addEventListener('load', () => { location.href = '${heldOrigin}/by-redirect'; });</script>`,
                ),
            ],
            [
                THREAD_HELD_PATH,
                htmlPage(
                    "<script>addEventListener('load', () => { setTimeout(() => { for (;;); }, 0); });</script>",
                ),
            ],
        ]),
    });
});

after(async () => {
    await harness.close();
    for (const hold of holds) {
        clearTimeout(hold);
    }
    heldServer.closeAllConnections();
    await new Promise((resolve) => heldServer.close(resolve));
});

describe("Using a run in a real browser", () => {
    describe("given a navigate to a page whose own redirect the server holds back while it settles", () => {
        describe("when a check follows it", () => {
            test("then it should fail the navigate with timeout at about the step's timeout, and skip the check", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate(REDIRECT_HELD_PATH),
                    NEVER_SHOWN_CHECK,
                ]);
                assert.deepEqual(
                    outcomes(result),
                    [
                        [NAVIGATE_STEP, "failed", "timeout"],
                        [1, "skipped", undefined],
                    ],
                    JSON.stringify(result.steps),
                );
                const took = result.timings.stepMilliseconds[NAVIGATE_STEP] ?? Infinity;
                assert.ok(took >= STEP_TIMEOUT_MILLISECONDS / 2, `gave up after ${took} ms`);
                assert.ok(took < LONGEST_NAVIGATE_MILLISECONDS, `gave up after ${took} ms`);
            });
        });
    });

    describe("given a navigate to a page that holds its own thread once it has loaded", () => {
        describe("when a check follows it", () => {
            test("then it should pass the navigate and fail the check with page-unreadable", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate(THREAD_HELD_PATH),
                    NEVER_SHOWN_CHECK,
                ]);
                assert.deepEqual(
                    outcomes(result),
                    [
                        [NAVIGATE_STEP, "passed", undefined],
                        [1, "failed", "page-unreadable"],
                    ],
                    JSON.stringify(result.steps),
                );
            });
        });
    });

    for (const { name, step } of CLICKS) {
        describe(`given a click on ${name} to a page the server holds back`, () => {
            describe("when the run ends", () => {
                test("then it should fail the click with timeout at about the step's timeout", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate("/start.html"),
                        step,
                        NEVER_SHOWN_CHECK,
                    ]);
                    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                    assert.equal(
                        result.steps[CLICK_STEP]?.code,
                        "timeout",
                        JSON.stringify(result.steps),
                    );
                    const took = result.timings.stepMilliseconds[CLICK_STEP] ?? Infinity;
                    assert.ok(took >= STEP_TIMEOUT_MILLISECONDS / 2, `gave up after ${took} ms`);
                    assert.ok(took < LONGEST_CLICK_MILLISECONDS, `gave up after ${took} ms`);
                });
            });
        });
    }

    for (const { name, step } of FORM_SUBMISSIONS) {
        for (const { name: browser, runOptions } of BROWSERS_OF_A_RUN) {
            describe(`given ${name} that sends a form to a page the server holds back`, () => {
                describe(`and the run on ${browser}`, () => {
                    describe("when a check follows it", () => {
                        test("then it should fail that step with timeout at about the step's timeout, and skip the check", async () => {
                            const { result } = await harness.runSteps(
                                TARGET,
                                [navigate("/start.html"), step, NEVER_SHOWN_CHECK],
                                runOptions(),
                            );
                            assert.deepEqual(
                                outcomes(result),
                                [
                                    [0, "passed", undefined],
                                    [CLICK_STEP, "failed", "timeout"],
                                    [2, "skipped", undefined],
                                ],
                                JSON.stringify(result.steps),
                            );
                            assert.equal(result.state, "Failed");
                            const took = result.timings.stepMilliseconds[CLICK_STEP] ?? Infinity;
                            assert.ok(
                                took >= STEP_TIMEOUT_MILLISECONDS / 2,
                                `gave up after ${took} ms`,
                            );
                            assert.ok(
                                took < LONGEST_CLICK_MILLISECONDS,
                                `gave up after ${took} ms`,
                            );
                        });
                    });
                });
            });
        }
    }
});
