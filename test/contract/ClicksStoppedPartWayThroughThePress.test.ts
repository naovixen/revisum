// A press is several events, and a page can stop any one of them on its way down, then react to it. That
// the first of them reached the element says nothing of the rest: a dialog holds the press at the event it
// opened during, and if that event never reached the button, the button has had no click. A dialog at
// mousedown holds the release back, so no click ever comes. One at mouseup holds the click until it is
// answered. A button's own listener that does the same at the same event has had its press, and the step
// passes.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { isHeldByADialog } from "#test-support/IsHeldByADialog.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    shownText,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const BUTTON = "save";
const TALLY = "tally";
const ANSWER = { type: "dialog", action: "accept" };
const NEXT_PAGE = "/next.html";

const pageWith =
    (pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <p data-testid="${TALLY}">0</p>
      <main><button type="button" data-testid="${BUTTON}">Save</button></main>
      <script>
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        let clicks = 0;
        button.addEventListener('click', () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        });
        ${pageScript}
      </script>
    </body></html>`,
    });

const stoppingAtTheWindow = (eventType: string, then: string): string =>
    `window.addEventListener('${eventType}', (event) => { event.stopImmediatePropagation(); ${then} }, true);`;
const stoppingAtTheDocument = (eventType: string, then: string): string =>
    `document.addEventListener('${eventType}', (event) => { event.stopPropagation(); ${then} }, true);`;
const onTheButton = (eventType: string, then: string): string =>
    `button.addEventListener('${eventType}', () => { ${then} });`;

const ALERTS = "alert('No');";

const STOPPED_PRESSES = [
    {
        name: "whose window stops mousedown and calls alert",
        path: "/window-stops-mousedown-and-alerts.html",
        script: stoppingAtTheWindow("mousedown", ALERTS),
        isDialogLeftOpen: true,
        tally: "0",
    },
    {
        name: "whose document stops mousedown and calls alert",
        path: "/document-stops-mousedown-and-alerts.html",
        script: stoppingAtTheDocument("mousedown", ALERTS),
        isDialogLeftOpen: true,
        tally: "0",
    },
    {
        name: "whose window stops mouseup and calls alert",
        path: "/window-stops-mouseup-and-alerts.html",
        script: stoppingAtTheWindow("mouseup", ALERTS),
        isDialogLeftOpen: true,
        tally: "1",
    },
    {
        name: "whose window stops pointerup and calls alert",
        path: "/window-stops-pointerup-and-alerts.html",
        script: stoppingAtTheWindow("pointerup", ALERTS),
        isDialogLeftOpen: true,
        tally: "1",
    },
    {
        name: "whose window stops mousedown and removes the button",
        path: "/window-stops-mousedown-and-removes.html",
        script: stoppingAtTheWindow("mousedown", "button.remove();"),
        isDialogLeftOpen: false,
        tally: "0",
    },
    {
        name: "whose window stops mousedown and click",
        path: "/window-stops-mousedown-and-click.html",
        script: `${stoppingAtTheWindow("mousedown", "")}${stoppingAtTheWindow("click", "")}`,
        isDialogLeftOpen: false,
        tally: "0",
    },
];

// Stopping one event of a press does not stop the browser sending the click that ends it.
const CLICK_STILL_ARRIVES = [
    {
        name: "whose window stops mousedown and does nothing else",
        path: "/window-stops-mousedown.html",
        script: stoppingAtTheWindow("mousedown", ""),
    },
    {
        name: "whose window stops mouseup and does nothing else",
        path: "/window-stops-mouseup.html",
        script: stoppingAtTheWindow("mouseup", ""),
    },
];

const BUTTON_REACTS_TO_MOUSEDOWN = [
    {
        name: "calls alert",
        path: "/button-alerts-on-mousedown.html",
        script: onTheButton("mousedown", ALERTS),
        isDialogLeftOpen: true,
    },
    {
        name: "navigates",
        path: "/button-navigates-on-mousedown.html",
        script: onTheButton("mousedown", `location.href = '${NEXT_PAGE}';`),
        isDialogLeftOpen: false,
    },
    {
        name: "only notes the press",
        path: "/button-notes-mousedown.html",
        script: onTheButton("mousedown", "button.dataset.pressed = 'yes';"),
        isDialogLeftOpen: false,
    },
];

const WINDOW_ONLY_ALERTS_AT_MOUSEDOWN = "/window-only-alerts-at-mousedown.html";
const WINDOW_ALERTS_AS_MOUSEDOWN_COMES_BACK_UP = "/window-alerts-as-mousedown-comes-back-up.html";

const ROUTES = new Map<string, FixtureRoute>([
    [NEXT_PAGE, pageWith("")],
    ...[...STOPPED_PRESSES, ...CLICK_STILL_ARRIVES, ...BUTTON_REACTS_TO_MOUSEDOWN].map(
        ({ path, script }) => [path, pageWith(script)] as const,
    ),
    [
        WINDOW_ONLY_ALERTS_AT_MOUSEDOWN,
        pageWith(`window.addEventListener('mousedown', () => { alert('Sure?'); }, true);`),
    ],
    [
        WINDOW_ALERTS_AS_MOUSEDOWN_COMES_BACK_UP,
        pageWith(`window.addEventListener('mousedown', () => { alert('Sure?'); });`),
    ],
]);

type ClickOutcome = {
    readonly failureCode: string | null;
    readonly isDialogOpen: boolean;
    readonly tally: string | null;
};

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

// What became of a click, and the tally once any dialog it left open has been answered.
const clickOn = async (page: string): Promise<ClickOutcome> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page))).ok, `${page} loads`);
        const acted = await session.act(
            harness.actionStep(click(testId(BUTTON))),
            allowEveryAction,
        );
        const isDialogOpen = await isHeldByADialog(session);
        if (isDialogOpen) {
            const answered = await session.act(harness.actionStep(ANSWER), allowEveryAction);
            assert.ok(answered.ok, JSON.stringify(answered));
        }
        return {
            failureCode: acted.ok ? null : acted.error.code,
            isDialogOpen,
            tally: await shownText(harness, session, TALLY).catch(() => null),
        };
    } finally {
        await session.close();
    }
};

describe("Using the real browser driver", () => {
    for (const { name, path, isDialogLeftOpen, tally } of STOPPED_PRESSES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: "not-actionable",
                        isDialogOpen: isDialogLeftOpen,
                        tally,
                    });
                });
            });
        });
    }

    for (const { name, path } of CLICK_STILL_ARRIVES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step, as the click reaches the button", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: null,
                        isDialogOpen: false,
                        tally: "1",
                    });
                });
            });
        });
    }

    for (const { name, path, isDialogLeftOpen } of BUTTON_REACTS_TO_MOUSEDOWN) {
        describe(`given a page whose button ${name} at mousedown, without stopping the press`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step", async () => {
                    const { failureCode, isDialogOpen } = await clickOn(path);
                    assert.deepEqual(
                        { failureCode, isDialogOpen },
                        { failureCode: null, isDialogOpen: isDialogLeftOpen },
                    );
                });
            });
        });
    }

    describe("given a page whose window calls alert as mousedown comes back up from the button", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, as the button has had its press", async () => {
                const { failureCode, isDialogOpen } = await clickOn(
                    WINDOW_ALERTS_AS_MOUSEDOWN_COMES_BACK_UP,
                );
                assert.deepEqual(
                    { failureCode, isDialogOpen },
                    { failureCode: null, isDialogOpen: true },
                );
            });
        });
    });

    describe("given the cost of telling a hostile page from an ordinary one", () => {
        describe("and an ordinary window listener that calls alert at mousedown without stopping it", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, as it cannot be told from a hostile page", async () => {
                    const { failureCode, isDialogOpen } = await clickOn(
                        WINDOW_ONLY_ALERTS_AT_MOUSEDOWN,
                    );
                    assert.deepEqual(
                        { failureCode, isDialogOpen },
                        { failureCode: "not-actionable", isDialogOpen: true },
                    );
                });
            });
        });
    });
});
