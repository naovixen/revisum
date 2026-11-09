// A capture masks every field a secret was typed into, and takes no image when one might still be on
// screen unmasked. A field that has gone holds nothing on screen, which is what signing in normally
// does, so that capture must be taken as usual. Only a field still on the page that its locator can
// no longer find is a reason to leave the image out. All values here are made up for tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { environmentSecretStore, type RunResult } from "@revisum/engine";
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
const SECRET_TEST_VALUE = "test-only-AAAAAAAAAAAA";
const CODE_FIELD = "Access code";
const SHOT = "after-sign-in";
const DONE = "signed-in";
const STEP_TIMEOUT_MILLISECONDS = 4000;
const CAPTURE_STEP = 4;

const page =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main>${body}</main></body></html>`,
    });

const CODE_FORM = `
  <form id="sign-in-form" onsubmit="return false">
    <label id="code-label" for="code">${CODE_FIELD}</label>
    <input id="code" type="text" autocomplete="off" style="width:600px;font-size:32px">
  </form>`;
const SHOWN_DONE = `<p data-testid="${DONE}" hidden>Signed in</p>`;
const showDone = `document.querySelector('[data-testid=${DONE}]').hidden = false;`;
const signInButton = (onClick: string): string =>
    `<button type="button" onclick="${onClick} ${showDone}">Sign in</button>`;

const ACCOUNT_PATH = "/account.html";

// Each way a sign-in may leave the field behind: its first page, and the step that signs in.
const FIELD_GONE: readonly {
    readonly name: string;
    readonly path: string;
    readonly body: string;
    readonly signIn: JsonRecord;
}[] = [
    {
        name: "a click that moves to another document",
        path: "/moves-on.html",
        body: `${CODE_FORM}<a href="${ACCOUNT_PATH}">Continue</a>`,
        signIn: click(role("link", "Continue")),
    },
    {
        name: "a plan's navigate to another document",
        path: "/plan-moves-on.html",
        body: CODE_FORM,
        signIn: navigate(ACCOUNT_PATH),
    },
    {
        name: "a click after which a script removes the field",
        path: "/removes-field.html",
        body: `${CODE_FORM}${signInButton("document.getElementById('code').remove();")}${SHOWN_DONE}`,
        signIn: click(role("button", "Sign in")),
    },
    {
        name: "a click after which a script removes its whole form",
        path: "/removes-form.html",
        body: `${CODE_FORM}${signInButton("document.getElementById('sign-in-form').remove();")}${SHOWN_DONE}`,
        signIn: click(role("button", "Sign in")),
    },
];

// Each way the field stays on screen, holding what was typed, while its locator finds nothing.
const FIELD_UNFINDABLE: readonly {
    readonly name: string;
    readonly path: string;
    readonly body: string;
}[] = [
    {
        name: "its label text has changed",
        path: "/renames-label.html",
        body: `${CODE_FORM}${signInButton("document.getElementById('code-label').textContent = 'Code used';")}${SHOWN_DONE}`,
    },
    {
        name: "its label has been removed",
        path: "/removes-label.html",
        body: `${CODE_FORM}${signInButton("document.getElementById('code-label').remove();")}${SHOWN_DONE}`,
    },
];

const FIELD_STILL_FOUND = {
    path: "/keeps-field.html",
    body: `${CODE_FORM}${signInButton("")}${SHOWN_DONE}`,
};

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [ACCOUNT_PATH, page(`<p data-testid="${DONE}">Signed in</p>`)],
            ...[...FIELD_GONE, ...FIELD_UNFINDABLE, FIELD_STILL_FOUND].map(
                ({ path, body }): [string, FixtureRoute] => [path, page(body)],
            ),
        ]),
        projectFile: (origin) => ({
            origins: [origin],
            limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
            secretNames: [SECRET],
            matrix: englishMatrix([TARGET]),
        }),
        seed: 67,
        fixedTimeMilliseconds: Date.UTC(2026, 10, 2, 12, 0, 0),
        drivers: driversForTargets([TARGET]),
        planFor: (targetId, steps, fields) =>
            rawPlan(
                {
                    featureId: "SHOTS-2",
                    specReference: "specs/shots.md#sign-in",
                    title: "Screenshots after a sign-in",
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

const captureAfterSignIn = (path: string, signIn: JsonRecord) =>
    harness.runSteps(
        TARGET,
        [
            navigate(path),
            fill(label(CODE_FIELD), secretValue(SECRET)),
            signIn,
            visible(testId(DONE), "sign-in.done-shown"),
            capture(SHOT),
            visible(testId(DONE), "sign-in.done-still-shown"),
        ],
        { secrets: environmentSecretStore({ [SECRET]: SECRET_TEST_VALUE }) },
    );

const captureStep = (result: RunResult) => {
    const step = result.steps[CAPTURE_STEP];
    assert.ok(step !== undefined, JSON.stringify(result.steps));
    return { outcome: step.outcome, code: step.code, state: result.state };
};

const SIGN_IN_BUTTON = click(role("button", "Sign in"));
const TAKEN = { outcome: "passed", code: undefined, state: "Passed" };
const LEFT_OUT = { outcome: "passed", code: "capture-left-out", state: "Passed" };

describe("Using a capture step in a real browser", () => {
    for (const { name, path, signIn } of FIELD_GONE) {
        describe(`given a secret typed into a field, and ${name}`, () => {
            describe("when the page is captured", () => {
                test("then it should take the image as usual", async () => {
                    const { result, store } = await captureAfterSignIn(path, signIn);
                    assert.deepEqual(captureStep(result), TAKEN);
                    assert.ok(store.get(`${TARGET}/${SHOT}.png`) !== undefined, "no image stored");
                });
            });
        });
    }

    for (const { name, path } of FIELD_UNFINDABLE) {
        describe(`given a secret typed into a field still on the page, where ${name}`, () => {
            describe("when the page is captured", () => {
                test("then it should leave the image out with capture-left-out", async () => {
                    const { result, store } = await captureAfterSignIn(path, SIGN_IN_BUTTON);
                    assert.deepEqual(captureStep(result), LEFT_OUT);
                    assert.equal(store.get(`${TARGET}/${SHOT}.png`), undefined);
                });
            });
        });
    }

    describe("given a secret typed into a field its locator still finds", () => {
        describe("when the page is captured", () => {
            test("then it should take the image", async () => {
                const { result, store } = await captureAfterSignIn(
                    FIELD_STILL_FOUND.path,
                    SIGN_IN_BUTTON,
                );
                assert.deepEqual(captureStep(result), TAKEN);
                assert.ok(store.get(`${TARGET}/${SHOT}.png`) !== undefined, "no image stored");
            });
        });
    });
});
