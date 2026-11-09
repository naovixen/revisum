// Whether a press that opened a dialog landed is read from what the page's check reported, and those
// reports reach the driver a moment later, over a socket. With several browsers busy at once they must
// still be in by the time the driver reads them, so a click the button really had stays a pass.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 5000;
const BUTTON = "save";
const PAGE = "/alert-on-click.html";
const PAGES_AT_ONCE = 6;
const CLICKS_ON_EACH = 4;

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <main><button type="button" data-testid="${BUTTON}">Save</button></main>
      <script>
        document.querySelector('[data-testid="${BUTTON}"]').addEventListener('click', () => { alert('Yes'); });
      </script>
    </body></html>`,
        }),
    ],
]);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

// What became of each click on one page after another, in a browser of its own.
const clicksInTurn = async (): Promise<readonly (string | null)[]> => {
    const failures: (string | null)[] = [];
    for (let turn = 0; turn < CLICKS_ON_EACH; turn += 1) {
        const session = await harness.openOwn(TARGET);
        try {
            assert.ok(
                (await session.navigate(harness.url(PAGE), scriptsEnabled)).ok,
                `${PAGE} loads`,
            );
            const acted = await session.act(
                harness.actionStep(click(testId(BUTTON))),
                allowEveryAction,
            );
            failures.push(acted.ok ? null : acted.error.detail);
        } finally {
            await session.close();
        }
    }
    return failures;
};

describe("Using the real browser driver", () => {
    describe("given several browsers busy at once, each on a page whose button calls alert on click", () => {
        describe("when a plan clicks the button on each, in turn", () => {
            test("then it should pass every step", { timeout: 170_000 }, async () => {
                const failures = await Promise.all(
                    Array.from({ length: PAGES_AT_ONCE }, clicksInTurn),
                );
                assert.deepEqual(
                    failures.flat(),
                    Array.from({ length: PAGES_AT_ONCE * CLICKS_ON_EACH }, () => null),
                );
            });
        });
    });
});
