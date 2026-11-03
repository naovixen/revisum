// A page cannot talk its way past the click check. What decides a click must be out of the page's
// reach: a page that writes over whatever the driver left on its window, or holds that place from the
// start, has still had a click that reached nothing, and the step fails.
// Every page here keeps the click from its button, so the step has only one honest outcome however
// the driver comes to know that.
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
} from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";

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
      <div id="cover" style="display:none;position:fixed;inset:0"></div>
      <script>
        let clicks = 0;
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        const cover = document.getElementById('cover');
        button.addEventListener('click', () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        });
        const namesAtLoad = new Set(Object.getOwnPropertyNames(window));
        const replaceWhatTheDriverAdded = (value) => {
          for (const name of Object.getOwnPropertyNames(window)) {
            if (!namesAtLoad.has(name)) window[name] = value;
          }
        };
        ${pageScript}
      </script>
    </body></html>`,
    });

const COVER_ARRIVES_WITH_THE_POINTER = `window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`;
const CLICK_STOPPED_ON_ITS_WAY_DOWN = `document.addEventListener('click', (event) => { event.stopPropagation(); }, true);`;

// Added at load, so it runs before anything the driver adds later.
const replacedAsThePressStarts = (value: string): string =>
    `window.addEventListener('pointerdown', () => { replaceWhatTheDriverAdded(${value}); }, true);`;

const FORGED_WITH_AN_UNKNOWN_STATE = `{ state: 'x', hasClickArrived: true, disarm() {} }`;
const FORGED_AS_A_HIT = `{ state: 'hit', hasClickArrived: true, disarm() {} }`;

const FORGING_PAGES = [
    {
        name: "whose press writes a check with an unknown state, and a cover takes the press",
        path: "/unknown-state-over-a-cover.html",
        script:
            COVER_ARRIVES_WITH_THE_POINTER + replacedAsThePressStarts(FORGED_WITH_AN_UNKNOWN_STATE),
    },
    {
        name: "whose press writes a check that says it hit, and a cover takes the press",
        path: "/hit-over-a-cover.html",
        script: COVER_ARRIVES_WITH_THE_POINTER + replacedAsThePressStarts(FORGED_AS_A_HIT),
    },
    {
        name: "whose button's own press handler writes a check that says it hit, and the click is stopped on its way down",
        path: "/hit-from-the-button.html",
        script: `${CLICK_STOPPED_ON_ITS_WAY_DOWN}
          button.addEventListener('pointerdown', () => { replaceWhatTheDriverAdded(${FORGED_AS_A_HIT}); });`,
    },
    {
        name: "that holds the place of the check from the start, and a cover takes the press",
        path: "/held-from-the-start.html",
        script: `${COVER_ARRIVES_WITH_THE_POINTER}
          Object.defineProperty(window, '__clickHitCheck', { get: () => (${FORGED_AS_A_HIT}), set() {} });`,
    },
];

const CLOBBERING_PAGES = [
    { value: "0", path: "/clobbered-with-zero.html" },
    { value: "''", path: "/clobbered-with-empty-text.html" },
    { value: "false", path: "/clobbered-with-false.html" },
];

const ROUTES = new Map<string, FixtureRoute>([
    ...FORGING_PAGES.map(({ path, script }) => [path, pageWith(script)] as const),
    ...CLOBBERING_PAGES.map(
        ({ path, value }) =>
            [
                path,
                pageWith(COVER_ARRIVES_WITH_THE_POINTER + replacedAsThePressStarts(value)),
            ] as const,
    ),
]);

type ClickOutcome = { readonly failureCode: string | null; readonly tally: string };

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
        assert.ok((await session.navigate(harness.url(page))).ok, `${page} loads`);
        const acted = await session.act(
            harness.actionStep(click(testId(BUTTON))),
            allowEveryAction,
        );
        return {
            failureCode: acted.ok ? null : acted.error.code,
            tally: await shownText(harness, session, TALLY),
        };
    } finally {
        await session.close();
    }
};

describe("Using the real browser driver", () => {
    for (const { name, path } of FORGING_PAGES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: "not-actionable",
                        tally: "0",
                    });
                });
            });
        });
    }

    for (const { value, path } of CLOBBERING_PAGES) {
        describe(`given a page whose press writes ${value} over the check, and a cover takes the press`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickOn(path), {
                        failureCode: "not-actionable",
                        tally: "0",
                    });
                });
            });
        });
    }
});
