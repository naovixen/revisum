// An input reaches the page once. A click waits for its element to be actionable, the guard is asked,
// and one press is sent: when that press lands on something else, the step fails at once. A cover the
// wait can see is a reason to wait and not a miss, and the wait may find a new element to press.
// Every count comes from the page itself. Its listener is added at load, so it runs before anything
// the driver adds later, and it sees each press whatever happens to that press afterwards.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import type { ActionGuard, ResolvedElement } from "@revisum/engine";
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
// Long beside a click that fails at once, so waiting it out cannot pass for failing quickly.
const STEP_TIMEOUT_MILLISECONDS = 5000;
const AT_ONCE_MILLISECONDS = STEP_TIMEOUT_MILLISECONDS / 2;
const UNCOVERED_AFTER_MILLISECONDS = 400;
const TALLY = "tally";
const BUTTON = "primary";
const SAVE = "Save";
const SEND = "Send";

// What the page saw: every press, the presses that landed on the cover, and the clicks that took
// effect on the button and on the cover.
const tallyOf = (presses: number, pressesOnCover: number, buttonClicks: number): string =>
    `presses=${presses} pressesOnCover=${pressesOnCover} buttonClicks=${buttonClicks} coverClicks=0`;

const COVER_STYLE = "position:fixed;inset:0";

const pageWith =
    (coverStyle: string, coverScript = ""): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>
      <p data-testid="${TALLY}">${tallyOf(0, 0, 0)}</p>
      <div id="slot"><button type="button" data-testid="${BUTTON}">${SAVE}</button></div>
      <div id="cover" style="${coverStyle}"></div>
      <script>
        const tally = { presses: 0, pressesOnCover: 0, buttonClicks: 0, coverClicks: 0 };
        const cover = document.getElementById('cover');
        const show = () => {
          document.querySelector('[data-testid="${TALLY}"]').textContent =
            'presses=' + tally.presses + ' pressesOnCover=' + tally.pressesOnCover
            + ' buttonClicks=' + tally.buttonClicks + ' coverClicks=' + tally.coverClicks;
        };
        window.addEventListener('pointerdown', (event) => {
          tally.presses += 1;
          if (event.target === cover) tally.pressesOnCover += 1;
          show();
        }, true);
        document.addEventListener('click', (event) => {
          if (event.target === cover) tally.coverClicks += 1;
          if (event.target.closest('[data-testid="${BUTTON}"]') !== null) tally.buttonClicks += 1;
          show();
        });
        ${coverScript}
      </script>
    </main></body></html>`,
    });

const ARRIVES_WITH_THE_POINTER = `window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`;
const LEAVES_WHEN_THE_PRESS_ENDS = `window.addEventListener('pointerup', (event) => { if (event.target === cover) cover.remove(); }, true);`;
const HIDDEN_COVER_STYLE = `display:none;${COVER_STYLE}`;

const ROUTES = new Map<string, FixtureRoute>([
    ["/nothing-in-the-way.html", pageWith(HIDDEN_COVER_STYLE)],
    [
        "/cover-arrives-and-leaves.html",
        pageWith(HIDDEN_COVER_STYLE, ARRIVES_WITH_THE_POINTER + LEAVES_WHEN_THE_PRESS_ENDS),
    ],
    ["/cover-arrives-and-stays.html", pageWith(HIDDEN_COVER_STYLE, ARRIVES_WITH_THE_POINTER)],
    ["/covered-from-the-start.html", pageWith(COVER_STYLE)],
]);

const takeTheCoverAwaySoon = async (session: DriverSession): Promise<void> => {
    await session.evaluate(() => {
        globalThis.setTimeout(() => document.getElementById("cover")?.remove(), 400);
        return "";
    });
};

const replaceTheButtonThenTakeTheCoverAwaySoon = async (session: DriverSession): Promise<void> => {
    await session.evaluate(() => {
        globalThis.setTimeout(() => {
            const replacement = document.createElement("button");
            replacement.type = "button";
            replacement.dataset["testid"] = "primary";
            replacement.textContent = "Send";
            document.getElementById("slot")?.replaceChildren(replacement);
            document.getElementById("cover")?.remove();
        }, 400);
        return "";
    });
};

type AskedAbout = Pick<ResolvedElement, "role" | "name"> & { readonly dialogText: string | null };

type ClickOutcome = {
    readonly failureCode: string | null;
    readonly elapsedMilliseconds: number;
    readonly tally: string;
    readonly asked: readonly AskedAbout[];
};

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const clickTheButtonOn = async (
    page: string,
    beforeTheClick: (session: DriverSession) => Promise<void> = () => Promise.resolve(),
): Promise<ClickOutcome> => {
    const asked: AskedAbout[] = [];
    const allowAndNote: ActionGuard = ({ role, name }, dialogText) => {
        asked.push({ role, name, dialogText });
        return { kind: "allow" };
    };
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page))).ok, `${page} loads`);
        await beforeTheClick(session);
        const started = Date.now();
        const acted = await session.act(harness.actionStep(click(testId(BUTTON))), allowAndNote);
        const elapsedMilliseconds = Date.now() - started;
        return {
            failureCode: acted.ok ? null : acted.error.code,
            elapsedMilliseconds,
            tally: await shownText(harness, session, TALLY),
            asked,
        };
    } finally {
        await session.close();
    }
};

const ASKED_ONCE_ABOUT_SAVE = [{ role: "button", name: SAVE, dialogText: null }];
const ASKED_ONCE_ABOUT_SEND = [{ role: "button", name: SEND, dialogText: null }];

describe("Using the real browser driver", () => {
    describe("given a button with nothing in the way", () => {
        describe("when a plan clicks it", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickTheButtonOn("/nothing-in-the-way.html");
            });

            test("then it should pass the step", () => {
                assert.equal(outcome.failureCode, null);
            });

            test("then it should send one press, which the button takes", () => {
                assert.equal(outcome.tally, tallyOf(1, 0, 1));
            });

            test("then it should ask the guard once, about the button", () => {
                assert.deepEqual(outcome.asked, ASKED_ONCE_ABOUT_SAVE);
            });
        });
    });

    describe("given a cover that arrives with the pointer and leaves when the press ends", () => {
        describe("when a plan clicks the button under it", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickTheButtonOn("/cover-arrives-and-leaves.html");
            });

            test("then it should fail the step as not-actionable", () => {
                assert.equal(outcome.failureCode, "not-actionable");
            });

            test("then it should send one press, which lands on the cover and takes no effect", () => {
                assert.equal(outcome.tally, tallyOf(1, 1, 0));
            });

            test("then it should ask the guard once, about the button", () => {
                assert.deepEqual(outcome.asked, ASKED_ONCE_ABOUT_SAVE);
            });
        });
    });

    describe("given a cover that arrives with the pointer and stays", () => {
        describe("when a plan clicks the button under it", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickTheButtonOn("/cover-arrives-and-stays.html");
            });

            test("then it should fail the step as not-actionable", () => {
                assert.equal(outcome.failureCode, "not-actionable");
            });

            test("then it should fail without waiting out the step's timeout", () => {
                assert.ok(
                    outcome.elapsedMilliseconds < AT_ONCE_MILLISECONDS,
                    `took ${outcome.elapsedMilliseconds} ms of a ${STEP_TIMEOUT_MILLISECONDS} ms timeout`,
                );
            });

            test("then it should send one press, which lands on the cover and takes no effect", () => {
                assert.equal(outcome.tally, tallyOf(1, 1, 0));
            });

            test("then it should ask the guard once, about the button", () => {
                assert.deepEqual(outcome.asked, ASKED_ONCE_ABOUT_SAVE);
            });
        });
    });

    describe("given a button covered until shortly after the click starts", () => {
        describe("when a plan clicks it", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickTheButtonOn(
                    "/covered-from-the-start.html",
                    takeTheCoverAwaySoon,
                );
            });

            test("then it should pass the step", () => {
                assert.equal(outcome.failureCode, null);
            });

            test("then it should wait for the cover to go before it sends", () => {
                assert.ok(
                    outcome.elapsedMilliseconds >= UNCOVERED_AFTER_MILLISECONDS / 2,
                    `took ${outcome.elapsedMilliseconds} ms`,
                );
            });

            test("then it should send one press, which the button takes", () => {
                assert.equal(outcome.tally, tallyOf(1, 0, 1));
            });

            test("then it should ask the guard once, about the button", () => {
                assert.deepEqual(outcome.asked, ASKED_ONCE_ABOUT_SAVE);
            });
        });
    });

    describe("given a button the page replaces while it is covered", () => {
        describe("when a plan clicks its test id", () => {
            let outcome: ClickOutcome;
            before(async () => {
                outcome = await clickTheButtonOn(
                    "/covered-from-the-start.html",
                    replaceTheButtonThenTakeTheCoverAwaySoon,
                );
            });

            test("then it should pass the step", () => {
                assert.equal(outcome.failureCode, null);
            });

            test("then it should send one press, which the replacement takes", () => {
                assert.equal(outcome.tally, tallyOf(1, 0, 1));
            });

            test("then it should ask the guard once, about the replacement", () => {
                assert.deepEqual(outcome.asked, ASKED_ONCE_ABOUT_SEND);
            });
        });
    });
});
