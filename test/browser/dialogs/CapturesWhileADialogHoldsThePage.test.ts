// While a dialog holds the page nothing can be read or drawn, and that is the same state whatever the plan
// typed earlier: a capture says dialog-open. Leaving the image out is for a page that could be read and
// showed a field that cannot be hidden, so a run must not pass with a capture it never had a chance to take.
// All values here are made up for tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { environmentSecretStore } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import {
    capture,
    click,
    fill,
    label,
    navigate,
    rawPlan,
    role,
    secretValue,
    testId,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const SECRET = "ACCESS_CODE";
const SECRET_TEST_VALUE = "test-only-BBBBBBBBBBBB";
const CODE_FIELD = "Access code";
const SHOT = "held-by-a-dialog";
const NOTE = "note";
const STEP_TIMEOUT_MILLISECONDS = 4000;

const page =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main>
          <p data-testid="${NOTE}">Shown</p>
          <label for="code">${CODE_FIELD}</label>
          <input id="code" type="text" autocomplete="off">
          ${body}
        </main></body></html>`,
    });

const ALERTS_PAGE = "/alerts.html";
const REMOVES_THE_FIELD_AND_ALERTS_PAGE = "/removes-the-field-and-alerts.html";
const ASK = role("button", "Ask");
const ANSWER = { type: "dialog", action: "accept" };
const TYPES_THE_SECRET = fill(label(CODE_FIELD), secretValue(SECRET));
const NOTE_SHOWN = visible(testId(NOTE), "note.shown");

const askButton = (onClick: string): string =>
    `<button type="button" onclick="${onClick}">Ask</button>`;

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [ALERTS_PAGE, page(askButton("alert('Held');"))],
            [
                REMOVES_THE_FIELD_AND_ALERTS_PAGE,
                page(askButton("document.getElementById('code').remove(); alert('Held');")),
            ],
        ]),
        projectFile: (origin) => ({
            origins: [origin],
            limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
            secretNames: [SECRET],
            matrix: englishMatrix([TARGET]),
        }),
        seed: 71,
        fixedTimeMilliseconds: Date.UTC(2026, 10, 2, 12, 0, 0),
        drivers: driversForTargets([TARGET]),
        planFor: (targetId, steps, fields) =>
            rawPlan(
                {
                    featureId: "SHOTS-3",
                    specReference: "specs/shots.md#dialogs",
                    title: "Screenshots while a dialog holds the page",
                },
                targetId,
                steps,
                fields,
            ),
    });
});
after(async () => {
    await harness.close();
});

// What became of a capture that follows the steps, and of the run, and whether an image was stored.
const captureAfter = async (steps: readonly JsonRecord[]) => {
    const { result, store } = await harness.runSteps(
        TARGET,
        [...steps, capture(SHOT), NOTE_SHOWN],
        {
            secrets: environmentSecretStore({ [SECRET]: SECRET_TEST_VALUE }),
        },
    );
    const step = result.steps[steps.length];
    assert.ok(step !== undefined, JSON.stringify(result.steps));
    return {
        outcome: step.outcome,
        code: step.code,
        state: result.state,
        isImageStored: store.get(`${TARGET}/${SHOT}.png`) !== undefined,
    };
};

const HELD = { outcome: "failed", code: "dialog-open", state: "Failed", isImageStored: false };

const WITH_A_DIALOG_OPEN = [
    {
        name: "no secret typed",
        steps: [navigate(ALERTS_PAGE), NOTE_SHOWN, click(ASK)],
    },
    {
        name: "a secret typed into a field still on the page",
        steps: [navigate(ALERTS_PAGE), NOTE_SHOWN, TYPES_THE_SECRET, click(ASK)],
    },
    {
        name: "a secret typed into a field that has since gone",
        steps: [
            navigate(REMOVES_THE_FIELD_AND_ALERTS_PAGE),
            NOTE_SHOWN,
            TYPES_THE_SECRET,
            click(ASK),
        ],
    },
];

describe("Using a capture step in a real browser", () => {
    for (const { name, steps } of WITH_A_DIALOG_OPEN) {
        describe(`given a dialog holding the page, and ${name}`, () => {
            describe("when the page is captured", () => {
                test("then it should fail the step with dialog-open and store no image", async () => {
                    assert.deepEqual(await captureAfter(steps), HELD);
                });
            });
        });
    }

    describe("given a secret typed into a field still on the page, and a dialog step has answered the dialog", () => {
        describe("when the page is captured", () => {
            test("then it should take the image", async () => {
                assert.deepEqual(
                    await captureAfter([
                        navigate(ALERTS_PAGE),
                        NOTE_SHOWN,
                        TYPES_THE_SECRET,
                        click(ASK),
                        ANSWER,
                    ]),
                    { outcome: "passed", code: undefined, state: "Passed", isImageStored: true },
                );
            });
        });
    });
});
