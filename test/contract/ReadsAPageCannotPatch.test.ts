// A read of the page runs in a script world of the driver's own, so what a page patches in its own world
// is not what the read calls. A page that breaks or forges its functions reads as the same page without
// them, whatever they would have said. The last tests are on a script's click on a label, which the
// browser forwards to the label's control marked as no person's, unlike a real press.
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
const SHOWN = "shown-note";
const NOWHERE = "no-such-note";
const FORGED_REPORT = `{"count":1,"visible":true,"enabled":true,"text":"Forged","value":null,"sensitive":false,"box":{"x":0,"y":0,"width":9,"height":9}}`;

const pageWith =
    (patch: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title><script>${patch}</script></head><body>
      <main><p data-testid="${SHOWN}" style="width:200px">Shown</p></main>
    </body></html>`,
    });

const PLAIN_PAGE = "/plain.html";
const PATCHES = [
    {
        name: "whose querySelectorAll throws",
        path: "/query-throws.html",
        patch: `Document.prototype.querySelectorAll = function () { throw new Error('broken'); };`,
    },
    {
        name: "whose querySelectorAll finds nothing",
        path: "/query-empty.html",
        patch: `Document.prototype.querySelectorAll = function () { return []; };`,
    },
    {
        name: "whose getBoundingClientRect throws",
        path: "/box-throws.html",
        patch: `Element.prototype.getBoundingClientRect = function () { throw new Error('broken'); };`,
    },
    {
        name: "whose getBoundingClientRect says no box",
        path: "/box-empty.html",
        patch: `Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; };`,
    },
    {
        name: "whose JSON.stringify gives a report of its own",
        path: "/forged-json.html",
        patch: `JSON.stringify = function () { return '${FORGED_REPORT}'; };`,
    },
];

const LABEL_PAGE = "/label.html";
const SCRIPT_CLICKS_THE_LABEL = "script-clicks-the-label";
const LABEL = "label";
const SEEN = "seen";

const ROUTES = new Map<string, FixtureRoute>([
    [PLAIN_PAGE, pageWith("")],
    ...PATCHES.map(({ path, patch }) => [path, pageWith(patch)] as const),
    [
        LABEL_PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Label</title></head><body style="margin:0">
      <label data-testid="${LABEL}" for="control" style="position:absolute;left:0;top:0;width:20px;height:20px;display:block">T</label>
      <input id="control" type="checkbox" aria-label="Control" style="position:absolute;left:100px;top:0">
      <button type="button" data-testid="${SCRIPT_CLICKS_THE_LABEL}" style="position:absolute;left:200px;top:0">Script</button>
      <p data-testid="${SEEN}" style="position:absolute;top:100px">none</p>
      <script>
        document.getElementById('control').addEventListener('click', (event) => {
          document.querySelector('[data-testid="${SEEN}"]').textContent =
            JSON.stringify([event.isTrusted, event.detail, event.clientX]);
        });
        document.querySelector('[data-testid="${SCRIPT_CLICKS_THE_LABEL}"]').addEventListener('click', () => {
          document.querySelector('[data-testid="${LABEL}"]').click();
        });
      </script></body></html>`,
        }),
    ],
]);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(undefined, ROUTES);
});
after(async () => {
    await harness.close();
});

const onPage = async <Value>(
    path: string,
    use: (session: Awaited<ReturnType<CapabilityHarness["openOwn"]>>) => Promise<Value>,
): Promise<Value> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(path), scriptsEnabled)).ok, `${path} loads`);
        return await use(session);
    } finally {
        await session.close();
    }
};

const readsOf = async (path: string) =>
    onPage(path, async (session) => ({
        shown: await session.probe(harness.locator(testId(SHOWN)), null),
        nowhere: await session.probe(harness.locator(testId(NOWHERE)), null),
    }));

// The page's own world, where the patches are, so a read's answer there is the patch's.
function whatThePagesOwnFunctionsSay(): string {
    try {
        return `${document.querySelectorAll("p").length} ${document.querySelector("p")?.getBoundingClientRect().width} ${JSON.stringify({})}`;
    } catch (error) {
        return String(error);
    }
}

const clickedThenSeen = async (locatorId: string): Promise<unknown> =>
    onPage(LABEL_PAGE, async (session) => {
        const acted = await session.act(
            harness.actionStep(click(testId(locatorId))),
            allowEveryAction,
        );
        assert.ok(acted.ok, JSON.stringify(acted));
        const seen: unknown = JSON.parse(await shownText(harness, session, SEEN));
        return seen;
    });

describe("Using the real browser driver", () => {
    for (const { name, path } of PATCHES) {
        describe(`given a page ${name}`, () => {
            describe("when a plan reads an element it shows and one it does not", () => {
                test("then it should read just what it reads on the same page unpatched", async () => {
                    assert.deepEqual(await readsOf(path), await readsOf(PLAIN_PAGE));
                });

                test("then it should have been a page whose own functions really are patched", async () => {
                    const says = (page: string) =>
                        onPage(page, (session) => session.evaluate(whatThePagesOwnFunctionsSay));
                    assert.notEqual(await says(path), await says(PLAIN_PAGE));
                });
            });
        });
    }

    describe("given a label for a checkbox", () => {
        describe("when a page's script clicks the label", () => {
            test("then it should forward a click that is marked as no person's", async () => {
                assert.deepEqual(await clickedThenSeen(SCRIPT_CLICKS_THE_LABEL), [false, 0, 0]);
            });
        });

        describe("when a plan presses the label", () => {
            test("then it should forward a click that carries the real press", async () => {
                assert.deepEqual(await clickedThenSeen(LABEL), [true, 1, 10]);
            });
        });
    });
});
