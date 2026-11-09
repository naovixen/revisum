// A hostile page can open a popup while the driver is still looking at the element a click would
// land on. If the guard then denies that click, the run must still say so: a denial reported as an
// unsupported popup leaves a Failed run whose audit log holds a denial nobody is told about.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    navigate,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { capabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import { TARGET, htmlPage, routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { PolicyRuleId, PolicyVerdictKind } from "@revisum/contracts";

// Long enough for the press's own step to have ended, well inside the time a press lets a page open one.
const POPUP_AFTER_THE_PRESS_MILLISECONDS = 500;
const BUTTONS_AFTER_THE_POPUP_MILLISECONDS = 300;

// The buttons wait, disabled, for what the Start button sets going, which opens one popup and then
// enables them. So the popup opens while an action waits for its element, and the driver has heard of it
// by the time that wait ends and the guard is asked. The press is what lets the browser open a popup at all: it blocks one that
// follows no user action.
const POPUP_WHILE_THE_NEXT_STEP_WAITS = `
  <script>
    const waiting = document.querySelectorAll('[data-testid="delete"], [data-testid="save"]');
    for (const button of waiting) { button.disabled = true; }
    document.querySelector('[data-testid="start"]').addEventListener('click', () => {
      setTimeout(() => {
        window.open('about:blank', '_blank');
        setTimeout(() => {
          for (const button of waiting) { button.disabled = false; }
        }, ${BUTTONS_AFTER_THE_POPUP_MILLISECONDS});
      }, ${POPUP_AFTER_THE_PRESS_MILLISECONDS});
    });
  </script>`;

const BUTTONS = `
  <button type="button" data-testid="start">Start</button>
  <button type="button" data-testid="delete">Delete account</button>
  <button type="button" data-testid="save">Save</button>
  <p data-testid="state">Ready</p>`;

const ROUTES = new Map([
    ["/hostile.html", htmlPage(`${BUTTONS}${POPUP_WHILE_THE_NEXT_STEP_WAITS}`)],
    ["/plain.html", htmlPage(BUTTONS)],
]);

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        routes: ROUTES,
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
                    assert.equal(result.denial.rule, "irreversible-action");
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

    describe("given the same page on the driver alone, with no run to keep the denial", () => {
        describe("when a guard denies a click once the popup has opened", () => {
            test("then it should fail the click with policy-denied, not as a popup", async () => {
                const onItsOwn = await capabilityHarness(undefined, ROUTES);
                const session = await onItsOwn.openOwn(TARGET);
                try {
                    assert.ok(
                        (await session.navigate(onItsOwn.url("/hostile.html"), scriptsEnabled)).ok,
                    );
                    const pressed = await session.act(
                        onItsOwn.actionStep(click(testId("start"))),
                        allowEveryAction,
                    );
                    assert.ok(pressed.ok, JSON.stringify(pressed));
                    const denied = await session.act(
                        onItsOwn.actionStep(click(testId("delete"))),
                        () => ({ kind: PolicyVerdictKind.Deny, rule: PolicyRuleId.IrreversibleAction, stepIndex: 2 }),
                    );
                    assert.ok(session.unsupportedOpenings() > 0, "the popup opened");
                    assert.equal(denied.ok ? "acted" : denied.error.code, "policy-denied");
                } finally {
                    await session.close();
                    await onItsOwn.close();
                }
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
