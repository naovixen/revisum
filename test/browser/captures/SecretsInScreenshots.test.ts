// Text drawn as pixels is out of reach of any text scan, so a capture must mask a field a secret was
// typed into, even a plain text input no personal-data selector matches. Two runs that differ only
// in the secret's value must therefore give the same pixels. All values here are made up for tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { environmentSecretStore } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import {
    capture,
    fill,
    label,
    navigate,
    rawPlan,
    secretValue,
    testId,
    visible,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { decodePng } from "#test-support/builders/DecodePng.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const SECRET = "ACCESS_CODE";
const CODE_FIELD = "Access code";
const SHOT = "after-fill";
const FIRST_VALUE = "test-only-AAAAAAAAAAAA";
const SECOND_VALUE = "test-only-WWWWWWWWWWWW";

const PAGE: FixtureRoute = () => ({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main>
      <p data-testid="page-title">Sign in</p>
      <label for="code">${CODE_FIELD}</label>
      <input id="code" type="text" autocomplete="off" style="width:600px;font-size:32px">
    </main></body></html>`,
});

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map([["/sign-in.html", PAGE]]),
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
                    featureId: "SHOTS-1",
                    specReference: "specs/shots.md#masking",
                    title: "Screenshots",
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

// The capture's pixels after `value` is typed into the code field, as the secret or as plain text.
async function pixelsAfterFilling(value: string, kind: "secret" | "plain"): Promise<Uint8Array> {
    const ran = await harness.runSteps(
        TARGET,
        [
            navigate("/sign-in.html"),
            fill(label(CODE_FIELD), kind === "secret" ? secretValue(SECRET) : value),
            capture(SHOT),
            visible(testId("page-title"), "page.title-shown"),
        ],
        { secrets: environmentSecretStore({ [SECRET]: value }) },
    );
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
    const bytes = ran.store.get(`${TARGET}/${SHOT}.png`);
    assert.ok(bytes !== undefined, "the capture was stored");
    return decodePng(bytes).data;
}

const differingBytes = (first: Uint8Array, second: Uint8Array): number => {
    assert.equal(first.length, second.length, "the two captures have the same size");
    return first.filter((byte, index) => byte !== second[index]).length;
};

describe("Using a capture step in a real browser", () => {
    describe("given a secret typed into a plain text input", () => {
        describe("when the page is captured with two different secret values", () => {
            test("then it should show the same pixels", async () => {
                const first = await pixelsAfterFilling(FIRST_VALUE, "secret");
                const second = await pixelsAfterFilling(SECOND_VALUE, "secret");
                assert.equal(differingBytes(first, second), 0);
            });
        });
    });

    describe("given plain text typed into the same input", () => {
        describe("when the page is captured with two different texts", () => {
            test("then it should show the difference", async () => {
                const first = await pixelsAfterFilling(FIRST_VALUE, "plain");
                const second = await pixelsAfterFilling(SECOND_VALUE, "plain");
                assert.ok(differingBytes(first, second) > 0, "the captures are identical");
            });
        });
    });
});
