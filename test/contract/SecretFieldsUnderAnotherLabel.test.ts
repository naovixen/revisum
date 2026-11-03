// A page may render a field afresh, under another label, still holding what was typed into the old one.
// The old field has gone, but the secret has not: it is on screen in a field the run has no locator
// for, so the capture must not go ahead. All values here are made up for the test.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { environmentSecretStore } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
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
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const SECRET = "ACCESS_CODE";
const SECRET_TEST_VALUE = "test-only-BBBBBBBBBBBB";
const CODE_FIELD = "Access code";
const SHOT = "after-rendering";
const DONE = "rendered";
const CAPTURE_STEP = 4;

const page =
    (script: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main>
          <form id="form" onsubmit="return false">
            <label for="code">${CODE_FIELD}</label>
            <input id="code" type="text" autocomplete="off" style="width:600px;font-size:32px">
          </form>
          <button type="button" onclick="${script} document.querySelector('[data-testid=${DONE}]').hidden = false;">Continue</button>
          <p data-testid="${DONE}" hidden>Rendered</p>
        </main></body></html>`,
    });

const rendersFieldHolding = (newValue: string): string =>
    `const typed = document.getElementById('code').value;
     document.getElementById('form').innerHTML = '<label for=\\'used\\'>Code used</label><input id=\\'used\\' type=\\'text\\' style=\\'width:600px;font-size:32px\\'>';
     document.getElementById('used').value = ${newValue};`;

const KEEPS_THE_SECRET = "/keeps-the-secret.html";
const KEEPS_ONLY_PART = "/keeps-the-last-characters.html";
const CLEARS_THE_FIELD = "/clears-the-field.html";

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [KEEPS_THE_SECRET, page(rendersFieldHolding("typed"))],
            [KEEPS_ONLY_PART, page(rendersFieldHolding("typed.slice(0, 16)"))],
            [CLEARS_THE_FIELD, page(rendersFieldHolding("''"))],
        ]),
        projectFile: (origin) => ({
            origins: [origin],
            limits: { stepTimeoutMilliseconds: 4000 },
            secretNames: [SECRET],
            matrix: englishMatrix([TARGET]),
        }),
        seed: 67,
        fixedTimeMilliseconds: Date.UTC(2026, 10, 2, 12, 0, 0),
        drivers: driversForTargets([TARGET]),
        planFor: (targetId, steps, fields) =>
            rawPlan(
                {
                    featureId: "SHOTS-3",
                    specReference: "specs/shots.md#rendering",
                    title: "Screenshots after a field is rendered again",
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

const captureAfterRendering = (path: string) =>
    harness.runSteps(
        TARGET,
        [
            navigate(path),
            fill(label(CODE_FIELD), secretValue(SECRET)),
            click(role("button", "Continue")),
            visible(testId(DONE), "rendering.done-shown"),
            capture(SHOT),
            visible(testId(DONE), "rendering.done-still-shown"),
        ],
        { secrets: environmentSecretStore({ [SECRET]: SECRET_TEST_VALUE }) },
    );

describe("Using a capture step in a real browser", () => {
    for (const { name, path } of [
        { name: "holding the secret", path: KEEPS_THE_SECRET },
        { name: "holding the secret's first characters", path: KEEPS_ONLY_PART },
    ]) {
        describe(`given a secret typed into a field the page has rendered again under another label, ${name}`, () => {
            describe("when the page is captured", () => {
                test("then it should leave the image out with capture-left-out", async () => {
                    const { result, store } = await captureAfterRendering(path);
                    assert.equal(
                        result.steps[CAPTURE_STEP]?.code,
                        "capture-left-out",
                        JSON.stringify(result.steps),
                    );
                    assert.equal(store.get(`${TARGET}/${SHOT}.png`), undefined);
                });
            });
        });
    }

    describe("given a secret typed into a field the page has rendered again, empty, under another label", () => {
        describe("when the page is captured", () => {
            test("then it should take the image as usual", async () => {
                const { result, store } = await captureAfterRendering(CLEARS_THE_FIELD);
                assert.equal(
                    result.steps[CAPTURE_STEP]?.code,
                    undefined,
                    JSON.stringify(result.steps),
                );
                assert.ok(store.get(`${TARGET}/${SHOT}.png`) !== undefined, "no image stored");
            });
        });
    });
});
