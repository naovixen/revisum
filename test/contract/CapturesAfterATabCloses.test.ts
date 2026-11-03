// A secret typed into a field of a second tab goes when that tab closes. A capture back on the first
// tab has nothing of it to hide, so it is taken as usual. Whether the element can still be asked
// about must make no difference. All values here are made up for tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { environmentSecretStore, type RunResult } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import {
    capture,
    fill,
    label,
    navigate,
    newTab,
    rawPlan,
    secretValue,
    testId,
    visible,
} from "#test-support/browser/RawPlan.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";

const TARGET = BrowserTarget.Chrome;
const SECRET = "ACCESS_CODE";
const SECRET_TEST_VALUE = "test-only-BBBBBBBBBBBB";
const CODE_FIELD = "Access code";
const SHOT = "back-on-the-first-tab";
const CAPTURE_STEP = 2;
const FIRST_TAB_MARK = "first-tab";

const page =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tabs</title></head><body><main>${body}</main></body></html>`,
    });

const CODE_INPUT = `<label for="code">${CODE_FIELD}</label><input id="code" type="text" autocomplete="off">`;
const SHOWN_MARK = `<p data-testid="${FIRST_TAB_MARK}">First tab</p>`;

const FIRST_PAGES: readonly { readonly name: string; readonly path: string }[] = [
    { name: "a first page without such a field", path: "/plain.html" },
    { name: "a first page with its own field of that name", path: "/same-field.html" },
];

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes: new Map<string, FixtureRoute>([
            ["/plain.html", page(SHOWN_MARK)],
            ["/same-field.html", page(`${SHOWN_MARK}${CODE_INPUT}`)],
            ["/code-tab.html", page(CODE_INPUT)],
        ]),
        projectFile: (origin) => ({
            origins: [origin],
            limits: { stepTimeoutMilliseconds: 4000 },
            secretNames: [SECRET],
            matrix: englishMatrix([TARGET]),
        }),
        seed: 68,
        fixedTimeMilliseconds: Date.UTC(2026, 10, 2, 12, 0, 0),
        drivers: driversForTargets([TARGET]),
        planFor: (targetId, steps, fields) =>
            rawPlan(
                {
                    featureId: "SHOTS-3",
                    specReference: "specs/shots.md#tabs",
                    title: "Screenshots after a tab closes",
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

const captureStep = (result: RunResult) => {
    const step = result.steps[CAPTURE_STEP];
    assert.ok(step !== undefined, JSON.stringify(result.steps));
    return { outcome: step.outcome, code: step.code, state: result.state };
};

describe("Using a capture step in a real browser", () => {
    for (const { name, path } of FIRST_PAGES) {
        describe(`given a secret typed into a field of a tab that has closed, and ${name}`, () => {
            describe("when the first tab is captured", () => {
                test("then it should take the image as usual", async () => {
                    const { result, store } = await harness.runSteps(
                        TARGET,
                        [
                            navigate(path),
                            newTab("/code-tab.html", [
                                fill(label(CODE_FIELD), secretValue(SECRET)),
                            ]),
                            capture(SHOT),
                            visible(testId(FIRST_TAB_MARK), "tabs.first-tab-shown"),
                        ],
                        { secrets: environmentSecretStore({ [SECRET]: SECRET_TEST_VALUE }) },
                    );
                    assert.deepEqual(captureStep(result), {
                        outcome: "passed",
                        code: undefined,
                        state: "Passed",
                    });
                    assert.ok(store.get(`${TARGET}/${SHOT}.png`) !== undefined, "no image stored");
                });
            });
        });
    }
});
