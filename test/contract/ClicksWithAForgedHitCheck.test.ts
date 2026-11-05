// A page cannot talk its way past the click check. What decides a click must be out of the page's
// reach: a page that writes over whatever the driver left on its window, or holds that place from the
// start, has still had a click that reached nothing, and the step fails.
// Nor can it by rewriting the built-ins the check might call, or by acting a click out with events of
// its own. The tally counts only clicks the browser made. The forging pages keep those from the button,
// so the step has only one honest outcome however the driver comes to know that; the pages whose click
// arrives show that a patched page is still given the verdict its click earned.
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
      <div id="cover" style="display:none;position:fixed;inset:0"></div>
      <script>
        let clicks = 0;
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        const cover = document.getElementById('cover');
        button.addEventListener('click', (event) => {
          if (!event.isTrusted) return;
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

const TAKES_THE_LISTENERS_AND_CALLS_THEM_WITH_A_FAKE_EVENT = `
  const takenListeners = [];
  window.addEventListener('pointerdown', () => {
    for (const { eventType, listener } of takenListeners) {
      listener({
        type: eventType,
        composedPath: () => [button],
        preventDefault() {},
        stopImmediatePropagation() {},
      });
    }
  }, true);
  EventTarget.prototype.addEventListener = function (eventType, listener) {
    takenListeners.push({ eventType, listener });
  };`;

const SYNTHETIC_EVENT_OPTIONS = `{ bubbles: true, composed: true }`;

const STOPS_THE_REAL_PRESS_AND_DISPATCHES_ITS_OWN = `
  for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(eventType, (event) => {
      if (!event.isTrusted) return;
      event.stopImmediatePropagation();
      if (event.type === 'pointerdown') {
        button.dispatchEvent(new PointerEvent('pointerdown', ${SYNTHETIC_EVENT_OPTIONS}));
        button.dispatchEvent(new MouseEvent('click', ${SYNTHETIC_EVENT_OPTIONS}));
      }
    }, true);
  }`;

const STOPS_THE_REAL_CLICK_AND_DISPATCHES_ITS_OWN = `
  window.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    button.dispatchEvent(new MouseEvent('click', ${SYNTHETIC_EVENT_OPTIONS}));
  }, true);`;

// Each makes a press on the cover read as a press on the button. Narrowed to that, so that the driver's
// other reads of the page still work.
const INCLUDES_ALWAYS_FINDS_THE_BUTTON = `
  const includes = Array.prototype.includes;
  Array.prototype.includes = function (searched, ...rest) {
    return searched === button || includes.call(this, searched, ...rest);
  };`;
const CLOSEST_LABEL_OF_THE_COVER_POINTS_AT_THE_BUTTON = `
  const closest = Element.prototype.closest;
  Element.prototype.closest = function (selector) {
    return this === cover && selector === 'label' ? { control: button } : closest.call(this, selector);
  };`;
const COMPOSED_PATH_STARTS_AT_THE_BUTTON = `
  const composedPath = Event.prototype.composedPath;
  Event.prototype.composedPath = function () {
    return [button, ...composedPath.call(this)];
  };`;

// A press seen on an element, with no click after it, passes if the element has gone: such a press took
// its element away. So this page has its button leave, as well as skewing where the press landed.
const BUTTON_LEAVES_AS_THE_PRESS_STARTS = `window.addEventListener('pointerdown', () => { button.remove(); }, true);`;

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
    {
        name: "that patches addEventListener to take the check's listeners and call them with a fake event, and a cover takes the press",
        path: "/fake-event-over-a-cover.html",
        script:
            COVER_ARRIVES_WITH_THE_POINTER + TAKES_THE_LISTENERS_AND_CALLS_THEM_WITH_A_FAKE_EVENT,
    },
    {
        name: "that stops the real press and dispatches a synthetic press and click at the button",
        path: "/synthetic-press-and-click.html",
        script: STOPS_THE_REAL_PRESS_AND_DISPATCHES_ITS_OWN,
    },
    {
        name: "that stops the real click and dispatches a synthetic click at the button",
        path: "/synthetic-click.html",
        script: STOPS_THE_REAL_CLICK_AND_DISPATCHES_ITS_OWN,
    },
    {
        name: "that patches Array includes to always find the button, and a cover takes the press",
        path: "/includes-over-a-cover.html",
        script: COVER_ARRIVES_WITH_THE_POINTER + INCLUDES_ALWAYS_FINDS_THE_BUTTON,
    },
    {
        name: "that patches Array includes to always find the button, a cover takes the press and the button leaves",
        path: "/includes-over-a-cover-and-button-leaves.html",
        script:
            COVER_ARRIVES_WITH_THE_POINTER +
            INCLUDES_ALWAYS_FINDS_THE_BUTTON +
            BUTTON_LEAVES_AS_THE_PRESS_STARTS,
    },
    {
        name: "that patches Element closest to give the cover a label for the button, and a cover takes the press",
        path: "/closest-over-a-cover.html",
        script: COVER_ARRIVES_WITH_THE_POINTER + CLOSEST_LABEL_OF_THE_COVER_POINTS_AT_THE_BUTTON,
    },
    {
        name: "that patches Element closest to give the cover a label for the button, a cover takes the press and the button leaves",
        path: "/closest-over-a-cover-and-button-leaves.html",
        script:
            COVER_ARRIVES_WITH_THE_POINTER +
            CLOSEST_LABEL_OF_THE_COVER_POINTS_AT_THE_BUTTON +
            BUTTON_LEAVES_AS_THE_PRESS_STARTS,
    },
    {
        name: "that patches Event composedPath to start at the button, and a cover takes the press",
        path: "/composed-path-over-a-cover.html",
        script: COVER_ARRIVES_WITH_THE_POINTER + COMPOSED_PATH_STARTS_AT_THE_BUTTON,
    },
    {
        name: "that patches Event composedPath to start at the button, a cover takes the press and the button leaves",
        path: "/composed-path-over-a-cover-and-button-leaves.html",
        script:
            COVER_ARRIVES_WITH_THE_POINTER +
            COMPOSED_PATH_STARTS_AT_THE_BUTTON +
            BUTTON_LEAVES_AS_THE_PRESS_STARTS,
    },
];

const PAGES_WHOSE_CLICK_ARRIVES = [
    {
        name: "that patches addEventListener harmlessly",
        path: "/add-listener-passed-through.html",
        script: `
          const add = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function (...callArguments) {
            return add.apply(this, callArguments);
          };`,
    },
    {
        name: "that patches addEventListener to add nothing from then on",
        path: "/add-listener-does-nothing.html",
        script: `EventTarget.prototype.addEventListener = function () {};`,
    },
];

const CLOBBERING_PAGES = [
    { value: "0", path: "/clobbered-with-zero.html" },
    { value: "''", path: "/clobbered-with-empty-text.html" },
    { value: "false", path: "/clobbered-with-false.html" },
];

const ROUTES = new Map<string, FixtureRoute>([
    ...FORGING_PAGES.map(({ path, script }) => [path, pageWith(script)] as const),
    ...PAGES_WHOSE_CLICK_ARRIVES.map(({ path, script }) => [path, pageWith(script)] as const),
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
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
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

    for (const { name, path } of PAGES_WHOSE_CLICK_ARRIVES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step, with one click", async () => {
                    assert.deepEqual(await clickOn(path), { failureCode: null, tally: "1" });
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
