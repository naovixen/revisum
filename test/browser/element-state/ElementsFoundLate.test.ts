// A step has one timeout, whatever it spent the time on. Finding an element late leaves that much less
// for what the input starts, so a step can't take twice its timeout by waiting first for the element
// and then for a server that holds its answer back.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { stepMilliseconds, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    label,
    navigate,
    role,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    TARGET,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4_000;
const SHOWN_LATE_MILLISECONDS = 3_200;
// The timeout and a little for the browser's own work, well short of the 7,200 ms that counting the
// timeout again from the input would take.
const LONGEST_STEP_MILLISECONDS = 5_500;
const HOLD_MILLISECONDS = 40_000;

const LATE_LINK = "Follow the link";
const LATE_FIELD = "Search";
const LATE_BUTTON = "Show the result";
const RESULT = "result";
const STEP_ON_THE_PAGE = 1;
const NEVER_SHOWN_CHECK: JsonRecord = {
    type: "expect",
    locator: testId("never-shown"),
    assert: { kind: "absent" },
    criterionId: "late.held-page-read",
};

const showLate = (id: string): string =>
    `<script>setTimeout(() => { document.getElementById('${id}').hidden = false; }, ${SHOWN_LATE_MILLISECONDS});</script>`;

const HELD_BACK_INPUTS: readonly {
    readonly name: string;
    readonly path: string;
    readonly step: JsonRecord;
}[] = [
    {
        name: "a click on a link shown late",
        path: "/late-link.html",
        step: click(role("link", LATE_LINK)),
    },
    {
        name: "an Enter press in a field shown late",
        path: "/late-field.html",
        step: { type: "press", locator: label(LATE_FIELD), key: "Enter" },
    },
];

let harness: BrowserHarness;
let heldServer: Server;
const holds = new Set<NodeJS.Timeout>();

before(async () => {
    heldServer = createServer((request, response) => {
        holds.add(setTimeout(() => response.socket?.destroy(), HOLD_MILLISECONDS));
    });
    await new Promise<void>((resolve) => heldServer.listen(0, "127.0.0.1", resolve));
    const heldOrigin = `http://127.0.0.1:${(heldServer.address() as AddressInfo).port}`;
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        otherOrigins: [heldOrigin],
        routes: new Map([
            [
                "/late-link.html",
                htmlPage(
                    `<a id="late" hidden href="${heldOrigin}/by-link">${LATE_LINK}</a>${showLate("late")}`,
                ),
            ],
            [
                "/late-field.html",
                htmlPage(
                    `<form id="late" hidden action="${heldOrigin}/by-enter"><label>${LATE_FIELD}<input name="q"></label></form>${showLate("late")}`,
                ),
            ],
            [
                "/late-button.html",
                htmlPage(
                    `<button id="late" hidden type="button" onclick="document.querySelector('[data-testid=${RESULT}]').hidden = false">${LATE_BUTTON}</button>
                     <p data-testid="${RESULT}" hidden>Shown</p>${showLate("late")}`,
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
    for (const { name, path, step } of HELD_BACK_INPUTS) {
        describe(`given ${name}, starting a navigation the server holds back`, () => {
            describe("when the run ends", () => {
                test("then it should fail the step with timeout within about one step timeout", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate(path),
                        step,
                        NEVER_SHOWN_CHECK,
                    ]);
                    assert.equal(
                        result.steps[STEP_ON_THE_PAGE]?.code,
                        "timeout",
                        JSON.stringify(result.steps),
                    );
                    const took = stepMilliseconds(result, STEP_ON_THE_PAGE);
                    assert.ok(took < LONGEST_STEP_MILLISECONDS, `the step took ${took} ms`);
                });
            });
        });
    }

    describe("given a click on a button shown late, whose work is done at once", () => {
        describe("when the run ends", () => {
            test("then it should pass the click", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate("/late-button.html"),
                    click(role("button", LATE_BUTTON)),
                    visible(testId(RESULT), "late.result-shown"),
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
