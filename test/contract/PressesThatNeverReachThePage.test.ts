// A click passes only when its press is known to have reached the page. A window listener the page
// added at load runs before anything the driver adds later, so it can stop a press before the
// driver sees it; the driver then has nothing to say the click landed, and a click that did nothing
// must not pass. A page that has moved on, or an element that has gone, says the press arrived. A
// page that breaks its own listener functions changes none of this: the click gets the verdict it earned.
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

const POINTER_EVENTS = `['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']`;

const pageWith =
    (pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>
      <button type="button" data-testid="${BUTTON}">Save</button>
      <a href="/moved.html" data-testid="to-the-next-page">Next page</a>
      <p data-testid="${TALLY}">0</p>
      <script>
        let clicks = 0;
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        button.addEventListener('click', () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        });
        ${pageScript}
      </script>
    </main></body></html>`,
    });

const SWALLOWS_EVERY_POINTER_EVENT = `
  for (const eventType of ${POINTER_EVENTS}) {
    window.addEventListener(eventType, (event) => { event.stopImmediatePropagation(); }, true);
  }`;

const ONLY_WATCHES_POINTER_EVENTS = `
  for (const eventType of ${POINTER_EVENTS}) {
    window.addEventListener(eventType, () => undefined, true);
  }`;

// Once the press has started, the page's own function for taking a listener off throws.
const BREAKS_REMOVING_LISTENERS_AS_THE_PRESS_STARTS = `
  const remove = EventTarget.prototype.removeEventListener;
  let isPressed = false;
  window.addEventListener('pointerdown', () => { isPressed = true; }, true);
  EventTarget.prototype.removeEventListener = function (...callArguments) {
    if (isPressed) throw new Error('this page broke removeEventListener');
    return remove.apply(this, callArguments);
  };`;

const AND_THE_BUTTON_LEAVES = `
  button.addEventListener('click', () => { button.remove(); });`;

const AND_A_COVER_TAKES_THE_PRESS = `
  const cover = document.createElement('div');
  cover.style.cssText = 'display:none;position:fixed;inset:0';
  document.body.append(cover);
  window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`;

const ROUTES = new Map<string, FixtureRoute>([
    ["/swallows.html", pageWith(SWALLOWS_EVERY_POINTER_EVENT)],
    ["/watches.html", pageWith(ONLY_WATCHES_POINTER_EVENTS)],
    ["/plain.html", pageWith("")],
    ["/broken-remove.html", pageWith(BREAKS_REMOVING_LISTENERS_AS_THE_PRESS_STARTS)],
    [
        "/broken-remove-and-button-leaves.html",
        pageWith(BREAKS_REMOVING_LISTENERS_AS_THE_PRESS_STARTS + AND_THE_BUTTON_LEAVES),
    ],
    [
        "/broken-remove-and-press-stopped.html",
        pageWith(BREAKS_REMOVING_LISTENERS_AS_THE_PRESS_STARTS + SWALLOWS_EVERY_POINTER_EVENT),
    ],
    [
        "/broken-remove-and-cover.html",
        pageWith(BREAKS_REMOVING_LISTENERS_AS_THE_PRESS_STARTS + AND_A_COVER_TAKES_THE_PRESS),
    ],
    ["/moved.html", pageWith("")],
]);

type ClickOutcome = { readonly failureCode: string | null; readonly tally: string | null };

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const clickOn = async (page: string, element = BUTTON): Promise<ClickOutcome> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page))).ok, `${page} loads`);
        const acted = await session.act(
            harness.actionStep(click(testId(element))),
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
    describe("given a page whose earlier window listeners stop every pointer event", () => {
        describe("when a plan clicks a button", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickOn("/swallows.html");
            });

            test("then it should fail the step as not-actionable", () => {
                assert.equal(outcome.failureCode, "not-actionable");
            });

            test("then it should leave the button with no click", () => {
                assert.equal(outcome.tally, "0");
            });
        });
    });

    for (const { name, page } of [
        { name: "whose earlier window listeners only watch pointer events", page: "/watches.html" },
        { name: "with no window listeners", page: "/plain.html" },
    ]) {
        describe(`given a page ${name}`, () => {
            describe("when a plan clicks a button", () => {
                let outcome: ClickOutcome;
                before(async () => {
                    outcome = await clickOn(page);
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

    describe("given a link to another page", () => {
        describe("when a plan clicks it", () => {
            test("then it should pass the step, with the click check gone with the old page", async () => {
                const outcome = await clickOn("/plain.html", "to-the-next-page");
                assert.equal(outcome.failureCode, null);
            });
        });
    });

    describe("given a page that breaks removeEventListener as the press starts", () => {
        describe("and the click reaches the button", () => {
            describe("when a plan clicks it", () => {
                test("then it should pass the step, with one click", async () => {
                    assert.deepEqual(await clickOn("/broken-remove.html"), {
                        failureCode: null,
                        tally: "1",
                    });
                });
            });
        });

        describe("and the click takes the button off the page", () => {
            describe("when a plan clicks it", () => {
                test("then it should pass the step, with one click", async () => {
                    assert.deepEqual(await clickOn("/broken-remove-and-button-leaves.html"), {
                        failureCode: null,
                        tally: "1",
                    });
                });
            });
        });

        describe("and its earlier window listeners stop every pointer event", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickOn("/broken-remove-and-press-stopped.html"), {
                        failureCode: "not-actionable",
                        tally: "0",
                    });
                });
            });
        });

        describe("and a cover takes the press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickOn("/broken-remove-and-cover.html"), {
                        failureCode: "not-actionable",
                        tally: "0",
                    });
                });
            });
        });
    });
});
