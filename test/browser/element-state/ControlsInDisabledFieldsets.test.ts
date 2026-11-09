// A plan's read of a control and a plan's click on it must give one answer, and it must be the platform's.
// A disabled fieldset disables the form controls inside it, except those in its first legend. It does
// nothing for an element that is not a form control, and that exception does not save a control from a
// disabled fieldset further out.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 1500;
const CONTROL = "control";

const BUTTON = `<button type="button" data-testid="${CONTROL}">Save</button>`;
const TEXT_INPUT = `<input data-testid="${CONTROL}" aria-label="Field">`;
const SELECT = `<select data-testid="${CONTROL}" aria-label="Choice"><option>One</option></select>`;
const TEXT_AREA = `<textarea data-testid="${CONTROL}" aria-label="Notes"></textarea>`;
const ANOTHER_BUTTON = `<button type="button">Other</button>`;

// Each page holds one control under test. What it should read as is the platform's own answer.
const CASES = [
    { name: "a button in no fieldset", body: BUTTON, isEnabled: true },
    {
        name: "a button with the disabled attribute",
        body: `<button type="button" data-testid="${CONTROL}" disabled>Save</button>`,
        isEnabled: false,
    },
    {
        name: "a button marked aria-disabled",
        body: `<button type="button" data-testid="${CONTROL}" aria-disabled="true">Save</button>`,
        isEnabled: false,
    },
    {
        name: "a button in a fieldset that is not disabled",
        body: `<fieldset>${BUTTON}</fieldset>`,
        isEnabled: true,
    },
    {
        name: "a button in a disabled fieldset",
        body: `<fieldset disabled>${BUTTON}</fieldset>`,
        isEnabled: false,
    },
    {
        name: "a text input in a disabled fieldset",
        body: `<fieldset disabled>${TEXT_INPUT}</fieldset>`,
        isEnabled: false,
    },
    {
        name: "a select in a disabled fieldset",
        body: `<fieldset disabled>${SELECT}</fieldset>`,
        isEnabled: false,
    },
    {
        name: "a text area in a disabled fieldset",
        body: `<fieldset disabled>${TEXT_AREA}</fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button deep inside a disabled fieldset",
        body: `<fieldset disabled><div><p>${BUTTON}</p></div></fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button in the first legend of a disabled fieldset",
        body: `<fieldset disabled><legend>${BUTTON}</legend></fieldset>`,
        isEnabled: true,
    },
    {
        name: "a text input in the first legend of a disabled fieldset",
        body: `<fieldset disabled><legend>${TEXT_INPUT}</legend></fieldset>`,
        isEnabled: true,
    },
    {
        name: "a button in a first legend that follows other content of a disabled fieldset",
        body: `<fieldset disabled><p>Before</p><legend>${BUTTON}</legend></fieldset>`,
        isEnabled: true,
    },
    {
        name: "a button in the second legend of a disabled fieldset",
        body: `<fieldset disabled><legend>First</legend><legend>${BUTTON}</legend></fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button in a legend that is not a child of the disabled fieldset",
        body: `<fieldset disabled><div><legend>${BUTTON}</legend></div></fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button in a fieldset that is not disabled, in the first legend of a disabled one",
        body: `<fieldset disabled><legend><fieldset>${BUTTON}</fieldset></legend></fieldset>`,
        isEnabled: true,
    },
    {
        name: "a button in the first legend of a fieldset inside a disabled one",
        body: `<fieldset disabled><fieldset><legend>${BUTTON}</legend></fieldset></fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button in the first legend of a disabled fieldset, inside a disabled one",
        body: `<fieldset disabled>${ANOTHER_BUTTON}<fieldset disabled><legend>${BUTTON}</legend></fieldset></fieldset>`,
        isEnabled: false,
    },
    {
        name: "a button in the first legends of two disabled fieldsets, one inside the other",
        body: `<fieldset disabled><legend><fieldset disabled><legend>${BUTTON}</legend></fieldset></legend></fieldset>`,
        isEnabled: true,
    },
    {
        name: "an element that is not a form control, in a disabled fieldset",
        body: `<fieldset disabled><div data-testid="${CONTROL}" role="button" tabindex="0">Save</div></fieldset>`,
        isEnabled: true,
    },
    {
        name: "a link in a disabled fieldset",
        body: `<fieldset disabled><a data-testid="${CONTROL}" href="#on">Save</a></fieldset>`,
        isEnabled: true,
    },
].map((shown, index) => ({ ...shown, path: `/control-${String(index)}.html` }));

const pageOf =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>${body}</main></body></html>`,
    });

const ROUTES = new Map<string, FixtureRoute>(
    CASES.map(({ path, body }) => [path, pageOf(body)] as const),
);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const NOT_ENABLED = /not enabled/;

// What the probe says of the control, and what became of a click on it.
const readAndClick = async (path: string) => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(path), scriptsEnabled)).ok, `${path} loads`);
        const read = expectOneElement(await session.probe(harness.locator(testId(CONTROL)), null));
        const acted = await session.act(
            harness.actionStep(click(testId(CONTROL))),
            allowEveryAction,
        );
        return {
            readsAsEnabled: read.enabled,
            isClickRefusedAsDisabled: !acted.ok && NOT_ENABLED.test(acted.error.detail),
            isClickPassed: acted.ok,
        };
    } finally {
        await session.close();
    }
};

describe("Using the real browser driver", () => {
    for (const { name, path, isEnabled } of CASES) {
        describe(`given ${name}`, () => {
            describe("when a plan reads it and clicks it", () => {
                test(`then it should say ${isEnabled ? "enabled" : "not enabled"} both times`, async () => {
                    assert.deepEqual(await readAndClick(path), {
                        readsAsEnabled: isEnabled,
                        isClickRefusedAsDisabled: !isEnabled,
                        isClickPassed: isEnabled,
                    });
                });
            });
        });
    }
});
