// A step has one timeout, and input it has not yet sent when that runs out must never be sent: it would
// reach the page during the failure's capture or the next step, as something the plan never asked for
// there. Each page here is held by the first event of an input for longer than the step's timeout, by a
// synchronous request to a slow route, as the page's own clock may be frozen. Once the page is free
// again, it counts what reached it. A second input of the same kind, on the page now free, shows the
// count would have seen it.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, fill, press, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    shownText,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 1500;
const HELD_FOR_MILLISECONDS = 4000;
// Long enough for anything the driver still had to send, once the page is free, to have arrived.
const SETTLE_MILLISECONDS = 1000;
const BUTTON = "save";
const FIELD = "note";
const TALLY = "tally";
const SLOW_PATH = "/slow";
const FREE_AGAIN_PATH = "/page-free-again";

const pageWith =
    (pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>
      <button type="button" data-testid="${BUTTON}" style="width: 200px; height: 60px">Save</button>
      <label for="${FIELD}">Note</label><input id="${FIELD}" data-testid="${FIELD}">
      <p data-testid="${TALLY}">0</p>
      <script>
        let isHeld = false;
        const holdOnce = () => {
          if (isHeld) return;
          isHeld = true;
          const request = new XMLHttpRequest();
          request.open('GET', '${SLOW_PATH}', false);
          request.send();
          fetch('${FREE_AGAIN_PATH}');
        };
        let count = 0;
        const counted = () => {
          count += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(count);
        };
        const field = document.querySelector('[data-testid="${FIELD}"]');
        ${pageScript}
      </script>
    </main></body></html>`,
    });

const SLOW_ROUTE: FixtureRoute = () => ({
    headers: { "content-type": "text/plain" },
    chunks: [Buffer.from("held "), Buffer.from("long enough")],
    chunkPauseMilliseconds: HELD_FOR_MILLISECONDS,
});

const HELD_INPUTS: readonly {
    readonly name: string;
    readonly action: string;
    readonly path: string;
    readonly script: string;
    readonly step: JsonRecord;
}[] = [
    {
        name: "whose first mousemove holds it",
        action: "clicks the button",
        path: "/held-by-the-first-mousemove.html",
        script: `
          window.addEventListener('mousemove', holdOnce, true);
          window.addEventListener('pointerdown', (event) => { if (event.isTrusted) counted(); }, true);`,
        step: click(testId(BUTTON)),
    },
    {
        name: "whose first keydown holds it",
        action: "presses Shift+d in the field",
        path: "/held-by-the-first-keydown.html",
        script: `
          window.addEventListener('keydown', (event) => {
            if (event.isTrusted && event.key.toLowerCase() === 'd') counted();
            holdOnce();
          }, true);`,
        step: press(testId(FIELD), "d", ["Shift"]),
    },
    {
        name: "whose field's focus holds it",
        action: "fills the field",
        path: "/held-by-the-field-focus.html",
        script: `
          field.addEventListener('focus', holdOnce);
          field.addEventListener('input', (event) => { if (event.isTrusted) counted(); });`,
        step: fill(testId(FIELD), "sent late"),
    },
];

const ROUTES = new Map<string, FixtureRoute>([
    [SLOW_PATH, SLOW_ROUTE],
    ...HELD_INPUTS.map(({ path, script }) => [path, pageWith(script)] as const),
]);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

type HeldInputOutcome = {
    readonly heldFailureCode: string | null;
    readonly countOnceFree: string;
    readonly freeFailureCode: string | null;
    readonly countAfterTheFreeInput: string;
};

// The held step's outcome and what had reached the page once it was free, then the same for a second
// input of the same kind on the free page.
const inputOn = async (page: string, step: JsonRecord): Promise<HeldInputOutcome> => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(page), scriptsEnabled)).ok, `${page} loads`);
        const freeAgain = harness.requested(FREE_AGAIN_PATH);
        const held = await session.act(harness.actionStep(step), allowEveryAction);
        await freeAgain;
        await pause(SETTLE_MILLISECONDS);
        const countOnceFree = await shownText(harness, session, TALLY);
        const free = await session.act(harness.actionStep(step), allowEveryAction);
        return {
            heldFailureCode: held.ok ? null : held.error.code,
            countOnceFree,
            freeFailureCode: free.ok ? null : free.error.code,
            countAfterTheFreeInput: await shownText(harness, session, TALLY),
        };
    } finally {
        await session.close();
    }
};

describe("Using the real browser driver", () => {
    for (const { name, action, path, step } of HELD_INPUTS) {
        describe(`given a page held past the step's timeout ${name}`, () => {
            describe(`when a plan ${action}`, () => {
                test("then it should fail the step with timeout and send nothing more once the step has ended", async () => {
                    assert.deepEqual(await inputOn(path, step), {
                        heldFailureCode: "timeout",
                        countOnceFree: "0",
                        freeFailureCode: null,
                        countAfterTheFreeInput: "1",
                    });
                });
            });
        });
    }
});
