// The click check holds wherever a click can happen: inside a frame, with the page's timers on virtual
// time, with its scripts off, after a dialog, and when the press itself sends the page elsewhere. A
// page's own handler running is not what it goes by: a framework that stops the browser's click and
// sends one of its own has had no click from the browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type DocumentSession, type DriverError } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { expectRead } from "#test-support/ExpectRead.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
const BUTTON = "save";
const TALLY = "tally";
const FRAME = "inner";
const ASK = "ask";
const LINK = "link";
const NOT_ACTIONABLE = "not-actionable";

const htmlRoute =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>${body}</body></html>`,
    });

const pageWith = (pageScript: string): FixtureRoute =>
    htmlRoute(`
      <p data-testid="${TALLY}">0</p>
      <main>
        <button type="button" data-testid="${ASK}">Ask</button>
        <button type="button" data-testid="${BUTTON}">Save</button>
      </main>
      <div id="cover" style="display:none;position:fixed;inset:0"></div>
      <script>
        let clicks = 0;
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        const ask = document.querySelector('[data-testid="${ASK}"]');
        const cover = document.getElementById('cover');
        const countClick = () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        };
        const namesAtLoad = new Set(Object.getOwnPropertyNames(window));
        const replaceWhatTheDriverAdded = (value) => {
          for (const name of Object.getOwnPropertyNames(window)) {
            if (!namesAtLoad.has(name)) window[name] = value;
          }
        };
        ${pageScript}
      </script>`);

const COUNTS_THE_BROWSERS_CLICKS = `button.addEventListener('click', (event) => { if (event.isTrusted) countClick(); });`;
const COVER_ARRIVES_WITH_THE_POINTER = `window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`;
const SYNTHETIC_EVENT_OPTIONS = `{ bubbles: true, composed: true }`;

const PLAIN_PAGE = "/plain.html";
const COVERED_PAGE = "/covered.html";
const FORGED_HIT_PAGE = "/forged-hit.html";
const SYNTHETIC_PRESS_PAGE = "/synthetic-press.html";
const DIALOG_ON_PRESS_PAGE = "/dialog-on-press.html";
const NAVIGATES_DURING_PRESS_PAGE = "/navigates-during-press.html";
const ARRIVED_PAGE = "/arrived.html";
const FRAMEWORK_PAGE = "/framework.html";
const LINK_PAGE = "/link.html";
const ALWAYS_COVERED_LINK_PAGE = "/always-covered-link.html";
const TIMER_PAGE = "/timer.html";
const TITLE_AT_LOAD = "Page";
const TITLE_A_SCRIPT_WRITES = "A script ran";
const WRITES_THE_TITLE = `document.title = '${TITLE_A_SCRIPT_WRITES}';`;

const framing = (framedPage: string): string => `/framing${framedPage}`;
const framingPage = (framedPage: string): FixtureRoute =>
    htmlRoute(
        `<iframe data-testid="${FRAME}" title="Inner" src="${framedPage}" style="width:600px;height:300px;border:0"></iframe>`,
    );

const PAGES_IN_FRAMES: ReadonlyMap<string, string> = new Map([
    [PLAIN_PAGE, COUNTS_THE_BROWSERS_CLICKS],
    [COVERED_PAGE, COUNTS_THE_BROWSERS_CLICKS + COVER_ARRIVES_WITH_THE_POINTER],
    [
        FORGED_HIT_PAGE,
        `${COUNTS_THE_BROWSERS_CLICKS}${COVER_ARRIVES_WITH_THE_POINTER}
         window.addEventListener('pointerdown', () => {
           replaceWhatTheDriverAdded({ state: 'hit', hasClickArrived: true, disarm() {} });
         }, true);`,
    ],
    [
        SYNTHETIC_PRESS_PAGE,
        `${COUNTS_THE_BROWSERS_CLICKS}
         for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
           window.addEventListener(eventType, (event) => {
             if (!event.isTrusted) return;
             event.stopImmediatePropagation();
             if (event.type === 'pointerdown') {
               button.dispatchEvent(new PointerEvent('pointerdown', ${SYNTHETIC_EVENT_OPTIONS}));
               button.dispatchEvent(new MouseEvent('click', ${SYNTHETIC_EVENT_OPTIONS}));
             }
           }, true);
         }`,
    ],
]);

const ROUTES = new Map<string, FixtureRoute>([
    ...[...PAGES_IN_FRAMES].map(([path, script]) => [path, pageWith(script)] as const),
    ...[...PAGES_IN_FRAMES.keys()].map((path) => [framing(path), framingPage(path)] as const),
    [
        DIALOG_ON_PRESS_PAGE,
        pageWith(`${COUNTS_THE_BROWSERS_CLICKS}
          ask.addEventListener('pointerdown', () => { alert('Are you sure?'); });`),
    ],
    [
        NAVIGATES_DURING_PRESS_PAGE,
        pageWith(
            `button.addEventListener('pointerdown', () => { location.href = '${ARRIVED_PAGE}'; });`,
        ),
    ],
    [ARRIVED_PAGE, htmlRoute(`<p data-testid="arrived">Arrived</p>`)],
    [
        FRAMEWORK_PAGE,
        pageWith(`
          button.addEventListener('click', (event) => { if (!event.isTrusted) countClick(); });
          window.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            event.stopImmediatePropagation();
            button.dispatchEvent(new MouseEvent('click', ${SYNTHETIC_EVENT_OPTIONS}));
          }, true);`),
    ],
    [
        TIMER_PAGE,
        pageWith(`${COUNTS_THE_BROWSERS_CLICKS}
          setTimeout(() => { ${WRITES_THE_TITLE} }, 0);`),
    ],
    [
        LINK_PAGE,
        htmlRoute(`<main><a data-testid="${LINK}" href="#followed">Go on</a></main>
          <script>${WRITES_THE_TITLE}</script>`),
    ],
    [
        ALWAYS_COVERED_LINK_PAGE,
        htmlRoute(`<main><a data-testid="${LINK}" href="#followed">Go on</a></main>
          <div style="position:fixed;inset:0"></div>`),
    ],
]);

type ClickOutcome = { readonly failureCode: string | null; readonly tally: string };

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const openSession = async (hasVirtualTimers: boolean) => {
    const opened = await ownDriverFor(TARGET).open(harness.target(TARGET), {
        ...harness.environment(),
        ...(hasVirtualTimers ? { virtualTimers: true } : {}),
    });
    assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
    return opened.value;
};

const clickOf = (id: string) => harness.actionStep(click(testId(id)));

const clickOutcomeIn = async (document: DocumentSession): Promise<ClickOutcome> => {
    const acted = await document.act(clickOf(BUTTON), allowEveryAction);
    return {
        failureCode: acted.ok ? null : acted.error.code,
        tally: expectOneElement(await document.probe(harness.locator(testId(TALLY)), null)).text,
    };
};

const clickOnPage = async (page: string, hasVirtualTimers: boolean): Promise<ClickOutcome> => {
    const session = await openSession(hasVirtualTimers);
    try {
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        return await clickOutcomeIn(session);
    } finally {
        await session.close();
    }
};

const clickInFrame = async (
    framedPage: string,
    hasVirtualTimers: boolean,
): Promise<ClickOutcome> => {
    const session = await openSession(hasVirtualTimers);
    try {
        const page = framing(framedPage);
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        const located = harness.locator(testId(FRAME));
        const inner = await session.frame(located);
        assert.ok(inner.ok, `the frame is found: ${JSON.stringify(inner)}`);
        return await clickOutcomeIn(inner.value);
    } finally {
        await session.close();
    }
};

const PRESS_REACHED_NOTHING: ClickOutcome = { failureCode: NOT_ACTIONABLE, tally: "0" };
const ONE_CLICK: ClickOutcome = { failureCode: null, tally: "1" };

describe("Using the real browser driver", () => {
    describe("given a button inside a frame", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, with one click", async () => {
                assert.deepEqual(await clickInFrame(PLAIN_PAGE, false), ONE_CLICK);
            });
        });

        describe("and a cover in that frame takes the press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(
                        await clickInFrame(COVERED_PAGE, false),
                        PRESS_REACHED_NOTHING,
                    );
                });
            });
        });

        describe("and the framed page writes a check that says it hit, while a cover takes the press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(
                        await clickInFrame(FORGED_HIT_PAGE, false),
                        PRESS_REACHED_NOTHING,
                    );
                });
            });
        });

        describe("and the framed page stops the real press and dispatches its own", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(
                        await clickInFrame(SYNTHETIC_PRESS_PAGE, false),
                        PRESS_REACHED_NOTHING,
                    );
                });
            });
        });
    });

    for (const { name, hasVirtualTimers, title } of [
        { name: "on virtual time", hasVirtualTimers: true, title: TITLE_AT_LOAD },
        { name: "in real time", hasVirtualTimers: false, title: TITLE_A_SCRIPT_WRITES },
    ]) {
        describe(`given a page with a timer, whose timers run ${name}`, () => {
            describe("when a plan clicks the button", () => {
                test(`then it should pass the step, with one click and the title "${title}"`, async () => {
                    const session = await openSession(hasVirtualTimers);
                    try {
                        const page = harness.url(TIMER_PAGE);
                        assert.ok(
                            (await session.navigate(page, scriptsEnabled)).ok,
                            "the page loads",
                        );
                        assert.deepEqual(await clickOutcomeIn(session), ONE_CLICK);
                        assert.equal(expectRead(await session.page()).title, title);
                    } finally {
                        await session.close();
                    }
                });
            });
        });
    }

    describe("given a page's timers run on virtual time", () => {
        describe("and a plain button", () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step, with one click", async () => {
                    assert.deepEqual(await clickOnPage(PLAIN_PAGE, true), ONE_CLICK);
                });
            });
        });

        describe("and a cover takes the press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickOnPage(COVERED_PAGE, true), PRESS_REACHED_NOTHING);
                });
            });
        });

        describe("and a button inside a frame", () => {
            describe("when a plan clicks the button", () => {
                test("then it should pass the step, with one click", async () => {
                    assert.deepEqual(await clickInFrame(PLAIN_PAGE, true), ONE_CLICK);
                });
            });
        });

        describe("and a cover in the frame takes the press", () => {
            describe("when a plan clicks the button", () => {
                test("then it should fail the step as not-actionable, with no click", async () => {
                    assert.deepEqual(await clickInFrame(COVERED_PAGE, true), PRESS_REACHED_NOTHING);
                });
            });
        });
    });

    describe("given a page loaded with its scripts off", () => {
        const clickLinkOn = async (page: string) => {
            const session = await openSession(false);
            try {
                const loaded = await session.navigate(harness.url(page), { scripts: "disabled" });
                assert.ok(loaded.ok, `${page} loads`);
                const acted = await session.act(clickOf(LINK), allowEveryAction);
                const { url, title } = expectRead(await session.page());
                return { acted, url, title };
            } finally {
                await session.close();
            }
        };

        describe("when a plan clicks a link", () => {
            test("then it should pass the step, and the browser should follow the link", async () => {
                const { acted, url, title } = await clickLinkOn(LINK_PAGE);
                assert.deepEqual(acted, { ok: true, value: undefined });
                assert.ok(url.endsWith("#followed"), url);
                assert.equal(title, TITLE_AT_LOAD, "the page's script did not run");
            });
        });

        describe("and the page has a cover over the link", () => {
            describe("when a plan clicks the link", () => {
                test("then it should fail the step as not-actionable, and the browser should not follow the link", async () => {
                    const { acted, url } = await clickLinkOn(ALWAYS_COVERED_LINK_PAGE);
                    assert.ok(!acted.ok, "the step fails");
                    assert.equal(acted.error.code, NOT_ACTIONABLE);
                    assert.ok(!url.endsWith("#followed"), url);
                });
            });
        });
    });

    describe("given a press that opened a dialog, which a plan has answered", () => {
        describe("when a plan clicks another button", () => {
            test("then it should pass that click, with one click", async () => {
                const session = await openSession(false);
                try {
                    const page = harness.url(DIALOG_ON_PRESS_PAGE);
                    assert.ok((await session.navigate(page, scriptsEnabled)).ok, "the page loads");
                    await session.act(clickOf(ASK), allowEveryAction);
                    const answered = await session.act(
                        harness.actionStep({ type: "dialog", action: "accept" }),
                        allowEveryAction,
                    );
                    assert.deepEqual(answered, { ok: true, value: undefined });
                    assert.deepEqual(await clickOutcomeIn(session), ONE_CLICK);
                } finally {
                    await session.close();
                }
            });
        });
    });

    describe("given a press that sends the page elsewhere", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, on the page it was sent to", async () => {
                const session = await openSession(false);
                try {
                    const page = harness.url(NAVIGATES_DURING_PRESS_PAGE);
                    assert.ok((await session.navigate(page, scriptsEnabled)).ok, "the page loads");
                    const acted = await session.act(clickOf(BUTTON), allowEveryAction);
                    assert.deepEqual(acted, { ok: true, value: undefined });
                    assert.equal(expectRead(await session.page()).url, harness.url(ARRIVED_PAGE));
                } finally {
                    await session.close();
                }
            });
        });
    });

    describe("given a framework that stops the browser's click and dispatches its own", () => {
        describe("when a plan clicks the button", () => {
            test("then it should fail the step as not-actionable, though the page's handler ran", async () => {
                const session = await openSession(false);
                try {
                    const page = harness.url(FRAMEWORK_PAGE);
                    assert.ok((await session.navigate(page, scriptsEnabled)).ok, "the page loads");
                    const acted = await session.act(clickOf(BUTTON), allowEveryAction);
                    const expected: DriverError = {
                        code: NOT_ACTIONABLE,
                        detail: "the page stopped the click before it reached the element",
                    };
                    assert.deepEqual(acted, { ok: false, error: expected });
                    const shown = expectOneElement(
                        await session.probe(harness.locator(testId(TALLY)), null),
                    );
                    assert.equal(shown.text, "1", "the framework's own click reached the handler");
                } finally {
                    await session.close();
                }
            });
        });
    });
});
