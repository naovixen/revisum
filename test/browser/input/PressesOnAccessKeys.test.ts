// A press with Alt held could be the page's access key for another control, which the plan never named
// and the runtime guard never saw. The driver sends such a press with no text, so the browser treats it
// as a shortcut for the focused field alone and an irreversible control stays as it was. This test
// pins that: if a browser or driver change ever lets the press through, the guard must learn of it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { label, navigate, press, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    TARGET,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const SEARCH_FIELD = "Search";
const NOT_PRESSED = "not pressed";

const PAGE = "/access-key.html";
const PAGE_WITH_ACCESS_KEY = `
  <label for="search">${SEARCH_FIELD}</label><input id="search">
  <button accesskey="d" onclick="document.querySelector('[data-testid=pressed]').textContent = 'pressed'">Delete account</button>
  <p data-testid="pressed">${NOT_PRESSED}</p>
  <p data-testid="key-seen">nothing</p>
  <script>
    document.getElementById("search").addEventListener("keydown", (event) => {
      if (event.key === "d") document.querySelector("[data-testid=key-seen]").textContent = "seen with Alt " + event.altKey;
    });
  </script>`;

const BUTTON_LEFT_ALONE = textEquals(testId("pressed"), NOT_PRESSED, "search.button-left-alone");

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        routes: new Map([[PAGE, htmlPage(PAGE_WITH_ACCESS_KEY)]]),
    });
});
after(async () => {
    await harness.close();
});

describe("Using a press step in a real browser", () => {
    describe("given an irreversible button whose access key is d, and a field beside it", () => {
        for (const modifiers of [["Alt"], ["Alt", "Shift"]]) {
            describe(`when the plan presses ${modifiers.join("+")}+d in the field`, () => {
                test("then it should leave the button as it was and raise no denial", async () => {
                    const { result, audit } = await harness.runSteps(TARGET, [
                        navigate(PAGE),
                        press(label(SEARCH_FIELD), "d", modifiers),
                        BUTTON_LEFT_ALONE,
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    assert.deepEqual(audit.recorded, []);
                });
            });
        }

        describe("when the plan presses Alt+d in the field", () => {
            test("then it should reach the field with Alt held", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate(PAGE),
                    press(label(SEARCH_FIELD), "d", ["Alt"]),
                    textEquals(testId("key-seen"), "seen with Alt true", "search.key-seen"),
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
