// The pointer's arrival can be what moves an element: a page reacts to the first mousemove by showing a
// notice above the button. A real person would look and aim again, so the driver has to see that its aim is
// stale before it presses. The press is what matters, as it is real input to whatever now lies at the old
// point. What arrives or moves after the press has begun stays a miss, as a real mouse would miss too. A
// cover that arrives with the pointer stays one as well, which ClicksAreSentOnce holds.
// Each page moves things once and deterministically, on an event of the click itself, so nothing here
// needs load or timing. Every count comes from the page.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { type DocumentSession } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, navigate, testId } from "#test-support/browser/RawPlan.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { download, expectDownload } from "../page-reads/support/PageStatesHarness.ts";
import { routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 3000;
// The step's deadline, and room to report what became of it on a busy machine.
const STEP_BOUND_MILLISECONDS = STEP_TIMEOUT_MILLISECONDS + 2000;
const HUNG_AFTER_MILLISECONDS = STEP_TIMEOUT_MILLISECONDS * 4;
const HUNG = "hung";
const NOT_ACTIONABLE = "not-actionable";
const BUTTON = "save";
const TALLY = "tally";
const FRAME = "frame";

const SHOW_THE_NOTICE = `const showNotice = () => { notice.style.padding = '30px'; notice.textContent = 'We use cookies'; };`;
const ONCE_ON = (eventType: string): string =>
    `${SHOW_THE_NOTICE} window.addEventListener('${eventType}', showNotice, { once: true });`;
const AT_EVERY_MOVE = `let isShown = false;
  window.addEventListener('mousemove', () => {
    isShown = !isShown;
    notice.style.padding = isShown ? '30px' : '0';
  });`;

// What took each trusted press and click, by id, noted before anything else the page does with them. The
// notice is what lies at the button's old point once it has pushed the button down. A press counts from
// pointerdown, as the driver swallows the mouse events of a press that misses.
const pageWith =
    (pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main id="main">
      <div id="notice"></div>
      <button type="button" id="${BUTTON}" data-testid="${BUTTON}">Save</button>
      <p data-testid="${TALLY}">{"presses":[],"clicks":[]}</p>
      <script>
        const notice = document.getElementById('notice');
        const seen = { presses: [], clicks: [] };
        const noteIn = (list) => (event) => {
          if (!event.isTrusted) return;
          list.push(event.target.id || event.target.localName);
          document.querySelector('[data-testid="${TALLY}"]').textContent = JSON.stringify(seen);
        };
        window.addEventListener('pointerdown', noteIn(seen.presses), true);
        window.addEventListener('click', noteIn(seen.clicks), true);
        ${pageScript}
      </script>
    </main></body></html>`,
    });

const framing =
    (framedPage: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Framing</title></head><body><main>
      <iframe data-testid="${FRAME}" title="Inner" src="${framedPage}" style="width:600px;height:400px;border:0"></iframe>
    </main></body></html>`,
    });

const MOVES_AT_MOUSEMOVE = "/moves-at-mousemove.html";
const MOVES_AT_MOUSEDOWN = "/moves-at-mousedown.html";
const MOVES_AT_MOUSEUP = "/moves-at-mouseup.html";
const MOVES_AT_EVERY_MOUSEMOVE = "/moves-at-every-mousemove.html";
const STAYS_STILL = "/stays-still.html";
const FRAMING_THE_MOVE = "/framing-the-move.html";

const ROUTES = new Map<string, FixtureRoute>([
    [MOVES_AT_MOUSEMOVE, pageWith(ONCE_ON("mousemove"))],
    [MOVES_AT_MOUSEDOWN, pageWith(ONCE_ON("mousedown"))],
    [MOVES_AT_MOUSEUP, pageWith(ONCE_ON("mouseup"))],
    [MOVES_AT_EVERY_MOUSEMOVE, pageWith(AT_EVERY_MOVE)],
    [STAYS_STILL, pageWith("")],
    [FRAMING_THE_MOVE, framing(MOVES_AT_MOUSEMOVE)],
]);

type ClickOutcome = {
    readonly failureCode: string | null;
    readonly elapsedMilliseconds: number;
    readonly presses: readonly string[];
    readonly clicks: readonly string[];
};

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const parsedTally = (text: string): { presses: string[]; clicks: string[] } => {
    const seen: unknown = JSON.parse(text);
    assert.ok(typeof seen === "object" && seen !== null && "presses" in seen && "clicks" in seen);
    assert.ok(Array.isArray(seen.presses) && Array.isArray(seen.clicks));
    return { presses: seen.presses.map(String), clicks: seen.clicks.map(String) };
};

const clickOutcomeIn = async (document: DocumentSession): Promise<ClickOutcome> => {
    const started = Date.now();
    const acted = await document.act(harness.actionStep(click(testId(BUTTON))), allowEveryAction);
    const elapsedMilliseconds = Date.now() - started;
    return {
        failureCode: acted.ok ? null : acted.error.code,
        elapsedMilliseconds,
        ...parsedTally(
            expectOneElement(await document.probe(harness.locator(testId(TALLY)), null)).text,
        ),
    };
};

const withOpenPage = async <Answer>(
    page: string,
    action: (session: DriverSession) => Promise<Answer>,
): Promise<Answer> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        return await action(session);
    } finally {
        await session.close();
    }
};

const clickOn = (page: string): Promise<ClickOutcome> => withOpenPage(page, clickOutcomeIn);

const clickInFrameOn = (page: string): Promise<ClickOutcome> =>
    withOpenPage(page, async (session) => {
        const located = harness.locator(testId(FRAME));
        const inner = await session.frame(located);
        assert.ok(inner.ok, `the frame is found: ${JSON.stringify(inner)}`);
        return clickOutcomeIn(inner.value);
    });

// The click and what the page saw, or word that it never ended, so a hang fails as itself.
const clickOnOrHang = async (page: string): Promise<ClickOutcome | typeof HUNG> => {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<typeof HUNG>((resolve) => {
        timer = setTimeout(() => {
            resolve(HUNG);
        }, HUNG_AFTER_MILLISECONDS);
    });
    try {
        return await Promise.race([clickOn(page), bound]);
    } finally {
        clearTimeout(timer);
    }
};

const ONE_PRESS_AND_ONE_CLICK_ON_THE_BUTTON = {
    failureCode: null,
    presses: [BUTTON],
    clicks: [BUTTON],
};

const withoutTiming = ({ failureCode, presses, clicks }: ClickOutcome) => ({
    failureCode,
    presses,
    clicks,
});

describe("Using the real browser driver", () => {
    describe("given a button that stays where it is", () => {
        describe("when a plan clicks it", () => {
            test("then it should pass the step, with one press and one click on the button", async () => {
                assert.deepEqual(
                    withoutTiming(await clickOn(STAYS_STILL)),
                    ONE_PRESS_AND_ONE_CLICK_ON_THE_BUTTON,
                );
            });
        });
    });

    describe("given a page that moves the button at the first mousemove", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, with one press and one click, both on the button", async () => {
                assert.deepEqual(
                    withoutTiming(await clickOn(MOVES_AT_MOUSEMOVE)),
                    ONE_PRESS_AND_ONE_CLICK_ON_THE_BUTTON,
                );
            });
        });

        describe("and the page is framed, with the move inside the frame", () => {
            describe("when a plan clicks the button in the frame", () => {
                test("then it should pass the step, with one press and one click, both on the button", async () => {
                    assert.deepEqual(
                        withoutTiming(await clickInFrameOn(FRAMING_THE_MOVE)),
                        ONE_PRESS_AND_ONE_CLICK_ON_THE_BUTTON,
                    );
                });
            });
        });
    });

    describe("given a page that moves the button at mousedown", () => {
        describe("when a plan clicks the button", () => {
            test("then it should fail the step as not-actionable, with the press on the button and no click on it", async () => {
                const { failureCode, presses, clicks } = await clickOn(MOVES_AT_MOUSEDOWN);
                assert.equal(failureCode, NOT_ACTIONABLE);
                assert.deepEqual(presses, [BUTTON]);
                assert.equal(clicks.includes(BUTTON), false, JSON.stringify(clicks));
            });
        });
    });

    describe("given a page that moves the button at mouseup", () => {
        describe("when a plan clicks the button", () => {
            test("then it should pass the step, as press and release both reached the button", async () => {
                assert.deepEqual(
                    withoutTiming(await clickOn(MOVES_AT_MOUSEUP)),
                    ONE_PRESS_AND_ONE_CLICK_ON_THE_BUTTON,
                );
            });
        });
    });

    describe("given a page that moves the button at every mousemove", () => {
        describe("when a plan clicks the button", () => {
            let outcome: ClickOutcome | typeof HUNG;
            before(async () => {
                outcome = await clickOnOrHang(MOVES_AT_EVERY_MOUSEMOVE);
            });

            test("then it should end inside the step's deadline, failing the step", () => {
                assert.notEqual(outcome, HUNG);
                assert.ok(outcome !== HUNG);
                assert.ok(
                    outcome.failureCode === NOT_ACTIONABLE || outcome.failureCode === "timeout",
                    String(outcome.failureCode),
                );
                assert.ok(
                    outcome.elapsedMilliseconds < STEP_BOUND_MILLISECONDS,
                    `took ${outcome.elapsedMilliseconds} ms`,
                );
            });

            test("then it should send no press at all", () => {
                assert.ok(outcome !== HUNG);
                assert.deepEqual(
                    { presses: outcome.presses, clicks: outcome.clicks },
                    {
                        presses: [],
                        clicks: [],
                    },
                );
            });
        });
    });
});

const FILE_MARKER = "moved-before-the-press-marker";
const FILE_NAME = "report";
const FILE_PATH = "/report.csv";
const MOVING_DOWNLOAD_PAGE = "/moving-download.html";
const MOVING_BUTTON = "starts-the-file";
const MOVING_LINK = "link-to-the-file";

const MOVING_DOWNLOAD_BODY = `<div id="notice"></div>
  <button type="button" data-testid="${MOVING_BUTTON}">Starts the file</button>
  <a href="${FILE_PATH}" data-testid="${MOVING_LINK}">Link to the file</a>
  <script>
    const notice = document.getElementById('notice');
    ${ONCE_ON("mousemove")}
    document.querySelector('[data-testid="${MOVING_BUTTON}"]').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = '${FILE_PATH}';
      link.download = 'report.csv';
      document.body.append(link);
      link.click();
    });
  </script>`;

describe("Using a run in a real browser", () => {
    let downloadHarness: BrowserHarness;
    let fileRequests = 0;

    before(async () => {
        downloadHarness = await routedPagesHarness({
            stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
            routes: new Map<string, FixtureRoute>([
                [
                    MOVING_DOWNLOAD_PAGE,
                    () => ({
                        headers: { "content-type": "text/html; charset=utf-8" },
                        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>${MOVING_DOWNLOAD_BODY}</main></body></html>`,
                    }),
                ],
                [
                    FILE_PATH,
                    () => {
                        fileRequests += 1;
                        return {
                            headers: {
                                "content-type": "text/csv",
                                "content-disposition": 'attachment; filename="report.csv"',
                            },
                            body: `name\n${FILE_MARKER}\n`,
                        };
                    },
                ],
            ]),
        });
    });
    after(async () => {
        await downloadHarness.close();
    });
    beforeEach(() => {
        fileRequests = 0;
    });

    for (const { name, id } of [
        { name: "a button whose handler starts a file", id: MOVING_BUTTON },
        { name: "a link to a file", id: MOVING_LINK },
    ]) {
        describe(`given ${name}, moved by the page at the first mousemove`, () => {
            describe("when a download step clicks it", () => {
                test("then it should claim the one file, once, and pass its check", async () => {
                    const { result } = await downloadHarness.runSteps(TARGET, [
                        navigate(MOVING_DOWNLOAD_PAGE),
                        download(FILE_NAME, testId(id)),
                        expectDownload(
                            FILE_NAME,
                            { kind: "contentContains", value: FILE_MARKER },
                            "report.holds-marker",
                        ),
                    ]);
                    assert.deepEqual(
                        outcomes(result),
                        [
                            [0, "passed", undefined],
                            [1, "passed", undefined],
                            [2, "passed", undefined],
                        ],
                        JSON.stringify(result.steps),
                    );
                    assert.equal(fileRequests, 1);
                });
            });
        });
    }
});
