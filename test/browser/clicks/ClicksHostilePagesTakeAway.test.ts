// A press must not pass because something got in its way: a page can stop every event of it and take the
// button away, open a dialog that holds the read, or navigate, and none of that is the button having been
// clicked. A page that does the same from the button's own listeners has had its press, and the step
// passes. The cost of telling them apart on ordinary pages is pinned here by name.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { isHeldByADialog } from "#test-support/IsHeldByADialog.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    shownText,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const BUTTON = "save";
const TALLY = "tally";
const ANSWER = { type: "dialog", action: "accept" };
const EVERY_POINTER_EVENT = `['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']`;
const NEXT_PAGE = "/next.html";

const pageWith =
    (
        pageScript: string,
        headers: Readonly<Record<string, string>> = {},
        controls = "",
    ): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8", ...headers },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <p data-testid="${TALLY}">0</p>
      <main><button type="button" data-testid="${BUTTON}">Save</button>${controls}</main>
      <script>
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        let clicks = 0;
        const count = () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        };
        button.addEventListener('click', count);
        ${pageScript}
      </script>
    </body></html>`,
    });

const stoppingAtTheWindow = (eventType: string, then: string): string =>
    `window.addEventListener('${eventType}', (event) => { event.stopImmediatePropagation(); ${then} }, true);`;

const stoppingEveryPointerEvent = (then: string): string =>
    `for (const eventType of ${EVERY_POINTER_EVENT}) {
       window.addEventListener(eventType, (event) => { event.stopImmediatePropagation(); ${then} }, true);
     }`;

const HOSTILE_PAGES = [
    {
        name: "that stops every pointer event and removes the button",
        path: "/stops-all-and-removes.html",
        script: stoppingEveryPointerEvent("button.remove();"),
        isDialogLeftOpen: false,
    },
    {
        name: "that stops click at the window and removes the button",
        path: "/stops-click-and-removes.html",
        script: stoppingAtTheWindow("click", "button.remove();"),
        isDialogLeftOpen: false,
    },
    {
        name: "that stops pointerdown and calls alert",
        path: "/stops-the-press-and-alerts.html",
        script: stoppingAtTheWindow("pointerdown", "alert('No');"),
        isDialogLeftOpen: true,
    },
    {
        name: "that stops click at the window and calls alert",
        path: "/stops-click-and-alerts.html",
        script: stoppingAtTheWindow("click", "alert('No');"),
        isDialogLeftOpen: true,
    },
    {
        name: "that stops every pointer event and navigates",
        path: "/stops-all-and-navigates.html",
        script: stoppingEveryPointerEvent(`location.href = '${NEXT_PAGE}';`),
        isDialogLeftOpen: false,
    },
];

const alertOnTheButtonAt = (eventType: string): string => `/button-alerts-on-${eventType}.html`;
const BUTTON_EVENTS_THAT_ALERT = ["click", "pointerdown", "mouseup"];

const WINDOW_LISTENER_THAT_ONLY_ALERTS = "/window-listener-only-alerts.html";
const SANDBOXED_WITHOUT_SCRIPTS = "/sandboxed.html";
const SANDBOXED_WITH_SCRIPTS = "/sandboxed-with-scripts.html";
const ELEMENT_DISABLED_ONLY_IN_SCRIPT = "/disabled-only-in-script.html";
const CUSTOM_CONTROL = "custom-control";

const ROUTES = new Map<string, FixtureRoute>([
    [NEXT_PAGE, pageWith("")],
    ...HOSTILE_PAGES.map(({ path, script }) => [path, pageWith(script)] as const),
    ...BUTTON_EVENTS_THAT_ALERT.map(
        (eventType) =>
            [
                alertOnTheButtonAt(eventType),
                pageWith(`button.addEventListener('${eventType}', () => { alert('Yes'); });`),
            ] as const,
    ),
    [
        WINDOW_LISTENER_THAT_ONLY_ALERTS,
        pageWith(`window.addEventListener('pointerdown', () => { alert('Sure?'); }, true);`),
    ],
    [SANDBOXED_WITHOUT_SCRIPTS, pageWith("", { "content-security-policy": "sandbox" })],
    [SANDBOXED_WITH_SCRIPTS, pageWith("", { "content-security-policy": "sandbox allow-scripts" })],
    [
        ELEMENT_DISABLED_ONLY_IN_SCRIPT,
        pageWith(
            `customElements.define('custom-control', class extends HTMLElement {
               get disabled() { return true; }
             });`,
            {},
            `<custom-control data-testid="${CUSTOM_CONTROL}" role="button" tabindex="0">Custom</custom-control>`,
        ),
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
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
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
    for (const { name, path, isDialogLeftOpen } of HOSTILE_PAGES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click counted", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: "not-actionable",
                        isDialogOpen: isDialogLeftOpen,
                        tally: "0",
                    });
                });
            });
        });
    }

    for (const eventType of BUTTON_EVENTS_THAT_ALERT) {
        describe(`given a page whose button calls alert on ${eventType}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step, with the dialog open", async () => {
                    const { failureCode, isDialogOpen } = await clickOn(
                        alertOnTheButtonAt(eventType),
                    );
                    assert.deepEqual(
                        { failureCode, isDialogOpen },
                        { failureCode: null, isDialogOpen: true },
                    );
                });
            });
        });
    }

    for (const { name, path, tally } of [
        { name: "with no scripts allowed", path: SANDBOXED_WITHOUT_SCRIPTS, tally: "0" },
        { name: "with scripts allowed", path: SANDBOXED_WITH_SCRIPTS, tally: "1" },
    ]) {
        describe(`given a page served with Content-Security-Policy: sandbox, ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: null,
                        isDialogOpen: false,
                        tally,
                    });
                });
            });
        });
    }

    describe("given the cost of telling a hostile page from an ordinary one", () => {
        describe("and an ordinary window listener that calls alert at the press without stopping it", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, as it cannot be told from a hostile page", async () => {
                    const { failureCode, isDialogOpen } = await clickOn(
                        WINDOW_LISTENER_THAT_ONLY_ALERTS,
                    );
                    assert.deepEqual(
                        { failureCode, isDialogOpen },
                        { failureCode: "not-actionable", isDialogOpen: true },
                    );
                });
            });
        });
    });

    describe("given a custom element whose disabled exists only as a JavaScript property", () => {
        describe("when a plan reads it", () => {
            test("then it should read as not enabled", async () => {
                const session = await harness.openOwn(TARGET);
                try {
                    const page = harness.url(ELEMENT_DISABLED_ONLY_IN_SCRIPT);
                    assert.ok((await session.navigate(page, scriptsEnabled)).ok);
                    const read = expectOneElement(
                        await session.probe(harness.locator(testId(CUSTOM_CONTROL)), null),
                    );
                    assert.equal(read.enabled, false);
                } finally {
                    await session.close();
                }
            });
        });
    });
});
