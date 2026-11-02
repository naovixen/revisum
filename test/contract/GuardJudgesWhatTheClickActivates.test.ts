// The runtime guard must judge what a click really does, in a real browser. A session given no guard
// must not click at all. A wrapper or an icon must not lend its harmless name to the destructive
// button it sits in or around. And a retry that finds a new element under the same test id must
// ask the guard about that element, not rely on what the first attempt was told.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    navigate,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import type { ActionStep, GuardVerdict, Session } from "@revisum/engine";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STATE = "page-state";
const UNTOUCHED = "Untouched";
const CLICKED = "Clicked";

// A page whose button of id "pressed-button" changes the state when pressed.
const pageWith =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>
      <p data-testid="${STATE}">${UNTOUCHED}</p>
      ${body}
      <script>
        const showClicked = () => { document.querySelector('[data-testid="${STATE}"]').textContent = '${CLICKED}'; };
        document.getElementById('pressed-button')?.addEventListener('click', showClicked);
      </script>
    </main></body></html>`,
    });

const buttonNamed = (name: string, inside = ""): string =>
    `<button type="button" id="pressed-button">${name}${inside}</button>`;
const wrapperAround = (name: string): string =>
    `<div data-testid="wrapper" role="group" aria-label="Account actions" style="display:inline-block">${buttonNamed(name)}</div>`;
const NAMED_ICON = `<span data-testid="icon" role="img" aria-label="Information">(i)</span>`;

// The pointer's arrival covers the page, so the first press lands on the cover. Taking the cover
// away is the page's re-render, which leaves `afterCover` under the test id "primary". Only that
// second button changes the state, so a change shows the retry pressed it. The page's listeners run
// before anything added later, so nothing can hold them up.
const coveredOnArrival = (first: string, afterCover: string): string => `
  <div id="slot"><button type="button" data-testid="primary">${first}</button></div>
  <div id="cover" style="display:none;position:fixed;inset:0"></div>
  <script>
    const cover = document.getElementById('cover');
    window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });
    window.addEventListener('pointerup', (event) => {
      if (event.target !== cover) return;
      cover.remove();
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.testid = 'primary';
      button.textContent = '${afterCover}';
      button.addEventListener('click', () => {
        document.querySelector('[data-testid="${STATE}"]').textContent = '${CLICKED}';
      });
      document.getElementById('slot').replaceChildren(button);
    }, true);
  </script>`;

const ROUTES = new Map<string, FixtureRoute>([
    ["/plain.html", pageWith(buttonNamed("Save"))],
    ["/wrapped-delete.html", pageWith(wrapperAround("Delete"))],
    ["/wrapped-save.html", pageWith(wrapperAround("Show details"))],
    ["/icon-in-delete.html", pageWith(buttonNamed("Delete account ", NAMED_ICON))],
    ["/icon-in-save.html", pageWith(buttonNamed("Show details ", NAMED_ICON))],
    [
        "/card-beside-delete.html",
        pageWith(`<div data-testid="card" role="group" aria-label="Order summary" onclick="this.dataset.opened = 'yes'; showClicked()">
            <p style="height:200px;margin:0">One order, placed today</p>
            <button type="button" onclick="event.stopPropagation()">Delete</button>
          </div>`),
    ],
    ["/save-becomes-delete.html", pageWith(coveredOnArrival("Save", "Delete account"))],
    ["/save-stays-save.html", pageWith(coveredOnArrival("Save", "Save"))],
]);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(2000, ROUTES);
});
after(async () => {
    await harness.close();
});

const clickOn = async (page: string, locator: JsonRecord) => {
    const ran = await harness.runSteps(
        TARGET,
        [navigate(page), click(locator), textEquals(testId(STATE), UNTOUCHED, "page.state-read")],
        { read: [STATE] },
    );
    return {
        state: ran.result.state,
        denial: ran.result.denial,
        shown: ran.atClose?.shown[STATE],
    };
};

// The same, when the click is meant to go through: the closing check expects the click's effect.
const clickThrough = async (page: string, locator: JsonRecord) => {
    const ran = await harness.runSteps(
        TARGET,
        [navigate(page), click(locator), textEquals(testId(STATE), CLICKED, "page.state-read")],
        { read: [STATE] },
    );
    return { state: ran.result.state, shown: ran.atClose?.shown[STATE] };
};

const DENIED_UNTOUCHED = {
    state: "Denied",
    denial: { rule: "irreversible-action", stepIndex: 1 },
    shown: UNTOUCHED,
};
const WENT_THROUGH = { state: "Passed", shown: CLICKED };

// Stands for a caller the type system cannot stop, so it still compiles once the guard is required.
const actWithoutGuard = (session: Session, step: ActionStep): ReturnType<Session["act"]> =>
    Reflect.apply(session.act.bind(session), undefined, [step]);

async function withPlainPage<Value>(use: (session: Session) => Promise<Value>): Promise<Value> {
    const session = await harness.open(TARGET);
    try {
        assert.ok((await session.navigate(harness.url("/plain.html"))).ok);
        return await use(session);
    } finally {
        await session.close();
    }
}

describe("Using the real browser driver", () => {
    describe("given a session asked to click with no guard", () => {
        describe("when it acts", () => {
            test("then it should send the page nothing and fail", async () => {
                const outcome = await withPlainPage(async (session) => {
                    const acted = await actWithoutGuard(
                        session,
                        harness.actionStep(click(role("button", "Save"))),
                    );
                    return { ok: acted.ok, shown: await harness.shownOn(session, STATE) };
                });
                assert.deepEqual(outcome, { ok: false, shown: UNTOUCHED });
            });
        });
    });

    describe("given a session asked to click with a guard that allows it", () => {
        describe("when it acts", () => {
            test("then it should click", async () => {
                const allow: GuardVerdict = { kind: "allow" };
                const outcome = await withPlainPage(async (session) => {
                    const acted = await session.act(
                        harness.actionStep(click(role("button", "Save"))),
                        () => allow,
                    );
                    return { ok: acted.ok, shown: await harness.shownOn(session, STATE) };
                });
                assert.deepEqual(outcome, { ok: true, shown: CLICKED });
            });
        });
    });

    describe("given a wrapper with a harmless label around a Delete button", () => {
        describe("when a plan clicks the wrapper", () => {
            test("then it should be denied and the button should not be pressed", async () => {
                assert.deepEqual(
                    await clickOn("/wrapped-delete.html", testId("wrapper")),
                    DENIED_UNTOUCHED,
                );
            });
        });
    });

    describe("given a wrapper with a harmless label around a harmless button", () => {
        describe("when a plan clicks the wrapper", () => {
            test("then it should press the button", async () => {
                assert.deepEqual(
                    await clickThrough("/wrapped-save.html", testId("wrapper")),
                    WENT_THROUGH,
                );
            });
        });
    });

    describe("given a named icon inside a destructive button", () => {
        describe("when a plan clicks the icon", () => {
            test("then it should be denied and the button should not be pressed", async () => {
                assert.deepEqual(
                    await clickOn("/icon-in-delete.html", testId("icon")),
                    DENIED_UNTOUCHED,
                );
            });
        });
    });

    describe("given a named icon inside a harmless button", () => {
        describe("when a plan clicks the icon", () => {
            test("then it should press the button", async () => {
                assert.deepEqual(
                    await clickThrough("/icon-in-save.html", testId("icon")),
                    WENT_THROUGH,
                );
            });
        });
    });

    describe("given a card that holds a Delete button away from its middle", () => {
        describe("when a plan clicks the card", () => {
            test("then it should click the card and not the button", async () => {
                assert.deepEqual(
                    await clickThrough("/card-beside-delete.html", testId("card")),
                    WENT_THROUGH,
                );
            });
        });
    });

    describe("given a plain allowed button", () => {
        describe("when a plan clicks it", () => {
            test("then it should press it", async () => {
                assert.deepEqual(
                    await clickThrough("/plain.html", role("button", "Save")),
                    WENT_THROUGH,
                );
            });
        });
    });

    describe("given a Save button whose first click misses", () => {
        describe("and the page then puts Delete account under the same test id", () => {
            describe("when a plan clicks that test id", () => {
                test("then it should be denied and Delete account should not be pressed", async () => {
                    assert.deepEqual(
                        await clickOn("/save-becomes-delete.html", testId("primary")),
                        DENIED_UNTOUCHED,
                    );
                });
            });
        });

        describe("and the page then puts Save back under the same test id", () => {
            describe("when a plan clicks that test id", () => {
                test("then it should retry and press Save", async () => {
                    assert.deepEqual(
                        await clickThrough("/save-stays-save.html", testId("primary")),
                        WENT_THROUGH,
                    );
                });
            });
        });
    });
});
