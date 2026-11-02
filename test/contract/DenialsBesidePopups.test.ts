// A hostile page can open a popup while the driver is still looking at the element a click would
// land on. If the guard then denies that click, the run must still say so: a denial reported as an
// unsupported popup leaves a Failed run whose audit log holds a denial nobody is told about.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    navigate,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { TARGET, htmlPage, routedPagesHarness } from "./RoutedPagesHarness.ts";

// Once the Start button has been pressed, the page opens one popup the next time anything measures
// an element, which an action's wait for its element does before the guard is asked. The press is
// what lets the browser open a popup at all: it blocks one that follows no user action.
const POPUP_ON_NEXT_MEASURE = `
  <script>
    const measure = Element.prototype.getBoundingClientRect;
    let isArmed = false;
    document.querySelector('[data-testid="start"]').addEventListener('click', () => { isArmed = true; });
    Element.prototype.getBoundingClientRect = function () {
      if (isArmed) {
        isArmed = false;
        window.open('about:blank', '_blank');
      }
      return measure.call(this);
    };
  </script>`;

const BUTTONS = `
  <button type="button" data-testid="start">Start</button>
  <button type="button" data-testid="delete">Delete account</button>
  <button type="button" data-testid="save">Save</button>
  <p data-testid="state">Ready</p>`;

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        routes: new Map([
            ["/hostile.html", htmlPage(`${BUTTONS}${POPUP_ON_NEXT_MEASURE}`)],
            ["/plain.html", htmlPage(BUTTONS)],
        ]),
    });
});
after(async () => {
    await harness.close();
});

const CLOSING_CHECK = visible(testId("state"), "state.shown");
const clickThen = (path: string, id: string): readonly JsonRecord[] => [
    navigate(path),
    click(testId("start")),
    click(testId(id)),
    CLOSING_CHECK,
];

describe("Using a run in a real browser", () => {
    describe("given a page that opens a popup while the driver looks at the element", () => {
        describe("and a click the guard denies", () => {
            describe("when the run ends", () => {
                test("then it should end Denied with policy-denied", async () => {
                    const { result, audit } = await harness.runSteps(
                        TARGET,
                        clickThen("/hostile.html", "delete"),
                    );
                    assert.ok(audit.recorded.length > 0, "the audit log holds the denial");
                    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                    assert.equal(result.denial?.rule, "irreversible-action");
                    assert.deepEqual(
                        outcomes(result)[2],
                        [2, "failed", "policy-denied"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });

        describe("and a click the guard allows", () => {
            describe("when the run ends", () => {
                test("then it should fail the click with unsupported-step", async () => {
                    const { result } = await harness.runSteps(
                        TARGET,
                        clickThen("/hostile.html", "save"),
                    );
                    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                    assert.deepEqual(
                        outcomes(result)[2],
                        [2, "failed", "unsupported-step"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });

    describe("given a page that opens no popup", () => {
        describe("and a click the guard denies", () => {
            describe("when the run ends", () => {
                test("then it should end Denied with policy-denied", async () => {
                    const { result } = await harness.runSteps(
                        TARGET,
                        clickThen("/plain.html", "delete"),
                    );
                    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                    assert.deepEqual(outcomes(result)[2], [2, "failed", "policy-denied"]);
                });
            });
        });
    });
});
