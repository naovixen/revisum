// A click passes only if the click event reached the element. A page can let pointerdown through and
// stop click on its way down, so the button never hears it: the press landed and nothing happened.
// A page that receives the click at its own button and then stops it going further has had a real
// click, and so has one that only calls preventDefault. A press that ends by taking the button away
// leaves no click to fire, and has done its work too.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
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

const pageWith =
    (pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <p data-testid="${TALLY}">0</p>
      <main><button type="button" data-testid="${BUTTON}">Save</button></main>
      <script>
        let clicks = 0;
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        const countClick = () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        };
        ${pageScript}
      </script>
    </body></html>`,
    });

const COUNTS_EACH_CLICK = `button.addEventListener('click', countClick);`;

const STOPPING_PAGES = [
    {
        name: "whose earlier window listener stops click alone",
        path: "/stopped-at-the-window.html",
        script: `${COUNTS_EACH_CLICK}
          window.addEventListener('click', (event) => { event.stopImmediatePropagation(); }, true);`,
    },
    {
        name: "whose document stops click on its way down",
        path: "/stopped-at-the-document.html",
        script: `${COUNTS_EACH_CLICK}
          document.addEventListener('click', (event) => { event.stopPropagation(); }, true);`,
    },
    {
        name: "whose element around the button stops click on its way down",
        path: "/stopped-at-a-parent.html",
        script: `${COUNTS_EACH_CLICK}
          document.querySelector('main').addEventListener('click', (event) => { event.stopPropagation(); }, true);`,
    },
];

const RECEIVING_PAGES = [
    { name: "that only listens", path: "/plain.html", script: COUNTS_EACH_CLICK },
    {
        name: "whose earlier window listener only calls preventDefault",
        path: "/prevented-at-the-window.html",
        script: `${COUNTS_EACH_CLICK}
          window.addEventListener('click', (event) => { event.preventDefault(); }, true);`,
    },
    {
        name: "whose button only calls preventDefault",
        path: "/prevented-at-the-button.html",
        script: `button.addEventListener('click', (event) => { event.preventDefault(); countClick(); });`,
    },
    {
        name: "whose button stops propagation after receiving the click",
        path: "/stopped-by-the-button.html",
        script: `button.addEventListener('click', (event) => { event.stopPropagation(); countClick(); });`,
    },
    {
        name: "whose button stops every later listener after receiving the click",
        path: "/stopped-at-once-by-the-button.html",
        script: `button.addEventListener('click', (event) => { event.stopImmediatePropagation(); countClick(); });`,
    },
    {
        name: "whose document stops click on its way back up",
        path: "/stopped-on-the-way-up.html",
        script: `${COUNTS_EACH_CLICK}
          document.addEventListener('click', (event) => { event.stopPropagation(); });`,
    },
];

const REMOVES_THE_BUTTON_AS_THE_PRESS_ENDS = "/removed-as-the-press-ends.html";

const ROUTES = new Map<string, FixtureRoute>([
    ...[...STOPPING_PAGES, ...RECEIVING_PAGES].map(
        ({ path, script }) => [path, pageWith(script)] as const,
    ),
    [
        REMOVES_THE_BUTTON_AS_THE_PRESS_ENDS,
        pageWith(`${COUNTS_EACH_CLICK}
          button.addEventListener('mouseup', () => { button.remove(); });`),
    ],
]);

type ClickOutcome = { readonly failureCode: string | null; readonly tally: string | null };

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const clickOn = async (page: string): Promise<ClickOutcome> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        const acted = await session.act(
            harness.actionStep(click(testId(BUTTON))),
            allowEveryAction,
        );
        return {
            failureCode: acted.ok ? null : acted.error.code,
            tally: await shownText(harness, session, TALLY).catch(() => null),
        };
    } finally {
        await session.close();
    }
};

describe("Using the real browser driver", () => {
    for (const { name, path } of STOPPING_PAGES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks a button", () => {
                let outcome: ClickOutcome;
                before(async () => {
                    outcome = await clickOn(path);
                });

                test("then it should fail the step as not-actionable", () => {
                    assert.equal(outcome.failureCode, "not-actionable");
                });

                test("then it should leave the button with no click", () => {
                    assert.equal(outcome.tally, "0");
                });
            });
        });
    }

    for (const { name, path } of RECEIVING_PAGES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks a button", () => {
                let outcome: ClickOutcome;
                before(async () => {
                    outcome = await clickOn(path);
                });

                test("then it should pass the step", () => {
                    assert.equal(outcome.failureCode, null);
                });

                test("then it should give the button one click", () => {
                    assert.equal(outcome.tally, "1");
                });
            });
        });
    }

    describe("given a page that takes the button away as the press ends", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, with no click left to fire", async () => {
                const outcome = await clickOn(REMOVES_THE_BUTTON_AS_THE_PRESS_ENDS);
                assert.deepEqual(outcome, { failureCode: null, tally: "0" });
            });
        });
    });
});
