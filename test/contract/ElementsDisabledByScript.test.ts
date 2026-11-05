// A custom element has no platform rule for disabled: its own disabled property is all there is, and a
// person cannot use a control that says it is disabled. So that property counts, however it is written, and
// one that cannot be read, or that answers neither a boolean nor undefined, cannot be taken to mean enabled.
// Reading it runs the page's code, which must get no say over anything else a read reports. On any other
// element a disabled property means nothing.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { OneElementRead } from "@revisum/engine";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { expectOneElement } from "#test-support/browser/ExpectOneElement.ts";
import { click, testId } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    shownText,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 1500;
const CONTROL = "control";
const TALLY = "tally";
const CONTROL_TEXT = "Custom";

const pageWith =
    (controls: string, pageScript: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <p data-testid="${TALLY}">0</p>
      <main>${controls}</main>
      <script>
        ${pageScript}
        const control = document.querySelector('[data-testid="${CONTROL}"]');
        let clicks = 0;
        EventTarget.prototype.addEventListener.call(control, 'click', () => {
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        });
      </script>
    </body></html>`,
    });

const CUSTOM_CONTROL = `<custom-control data-testid="${CONTROL}" role="button" tabindex="0">${CONTROL_TEXT}</custom-control>`;

const customElementWith = (classBody: string): string =>
    `customElements.define('custom-control', class extends HTMLElement { ${classBody} });`;

const customPage = (classBody: string): FixtureRoute =>
    pageWith(CUSTOM_CONTROL, customElementWith(classBody));

const settingDisabledInTheConstructor = (isDisabled: boolean): string =>
    `constructor() { super(); this.disabled = ${String(isDisabled)}; }`;

const DISABLED_CUSTOM_ELEMENTS = [
    {
        name: "sets disabled to true in its constructor",
        path: "/custom-set-true.html",
        route: customPage(settingDisabledInTheConstructor(true)),
    },
    {
        name: "has a disabled getter that returns true",
        path: "/custom-getter-true.html",
        route: customPage("get disabled() { return true; }"),
    },
    {
        name: "has disabled set to true by a script once it is on the page",
        path: "/custom-set-true-later.html",
        route: pageWith(
            CUSTOM_CONTROL,
            `${customElementWith("")}
             document.querySelector('[data-testid="${CONTROL}"]').disabled = true;`,
        ),
    },
    {
        name: "has a disabled getter that throws",
        path: "/custom-getter-throws.html",
        route: customPage("get disabled() { throw new Error('No'); }"),
    },
    {
        name: "has a disabled getter that returns null",
        path: "/custom-getter-null.html",
        route: customPage("get disabled() { return null; }"),
    },
    {
        name: "has a disabled getter that returns 0",
        path: "/custom-getter-zero.html",
        route: customPage("get disabled() { return 0; }"),
    },
    {
        name: "has a disabled getter that returns an empty string",
        path: "/custom-getter-empty-string.html",
        route: customPage("get disabled() { return ''; }"),
    },
    {
        name: "has a disabled getter that returns a string",
        path: "/custom-getter-string.html",
        route: customPage("get disabled() { return 'false'; }"),
    },
];

const ENABLED_CUSTOM_ELEMENTS = [
    {
        name: "sets disabled to false in its constructor",
        path: "/custom-set-false.html",
        route: customPage(settingDisabledInTheConstructor(false)),
    },
    {
        name: "has a disabled getter that returns false",
        path: "/custom-getter-false.html",
        route: customPage("get disabled() { return false; }"),
    },
    {
        name: "has no disabled property",
        path: "/custom-no-property.html",
        route: customPage(""),
    },
    // Undefined is what an uninitialised reactive property reads as: the same as having none.
    {
        name: "has a disabled getter that returns undefined",
        path: "/custom-getter-undefined.html",
        route: customPage("get disabled() { return undefined; }"),
    },
    {
        name: "declares a disabled field with no value",
        path: "/custom-field-undefined.html",
        route: customPage("disabled;"),
    },
];

const ORDINARY_CONTROL = `<div data-testid="${CONTROL}" role="button" tabindex="0">${CONTROL_TEXT}</div>`;
const ON_THE_ORDINARY_CONTROL = `document.querySelector('[data-testid="${CONTROL}"]')`;

const ORDINARY_ELEMENTS = [
    {
        name: "a disabled property set to true",
        path: "/ordinary-property-true.html",
        route: pageWith(ORDINARY_CONTROL, `${ON_THE_ORDINARY_CONTROL}.disabled = true;`),
    },
    {
        name: "a disabled getter that throws",
        path: "/ordinary-getter-throws.html",
        route: pageWith(
            ORDINARY_CONTROL,
            `Object.defineProperty(${ON_THE_ORDINARY_CONTROL}, 'disabled', { get() { throw new Error('No'); } });`,
        ),
    },
];

const FORGED_TEXT = "forged";
const FORGED_REPORT = JSON.stringify({
    count: 1,
    visible: true,
    enabled: true,
    text: FORGED_TEXT,
    value: FORGED_TEXT,
    sensitive: false,
    box: { x: 1, y: 2, width: 3, height: 4 },
});

// Every built-in a read of an element could call, patched to report something other than the truth.
const PATCHES_THE_BUILT_INS = `
  JSON.stringify = () => '${FORGED_REPORT}';
  JSON.parse = () => (${FORGED_REPORT});
  Reflect.get = () => '${FORGED_TEXT}';
  Reflect.apply = () => '${FORGED_REPORT}';
  Object.hasOwn = () => false;
  window.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  Element.prototype.getBoundingClientRect = () => ({ x: 1, y: 2, width: 3, height: 4 });
  Element.prototype.getAttribute = () => null;
  Element.prototype.matches = () => false;
  Element.prototype.querySelectorAll = () => [];
  Document.prototype.querySelectorAll = () => [];
  DocumentFragment.prototype.querySelectorAll = () => [];
  Node.prototype.getRootNode = function () { return document; };
  Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return '${FORGED_TEXT}'; } });
  Object.defineProperty(Node.prototype, 'textContent', { get() { return '${FORGED_TEXT}'; } });`;

const PASSWORD_FIELD = `<input type="password" aria-label="Password">`;
const NOT_DRAWN_CONTROL = `<custom-control data-testid="${CONTROL}" style="display:none">${CONTROL_TEXT}</custom-control>`;
const CONTROL_HOLDING_A_PASSWORD_FIELD = `<custom-control data-testid="${CONTROL}">${CONTROL_TEXT}${PASSWORD_FIELD}</custom-control>`;

const NOT_DRAWN_FIELDS = {
    count: 1,
    visible: false,
    text: CONTROL_TEXT,
    value: null,
    sensitive: false,
    box: { x: 0, y: 0, width: 0, height: 0 },
};

const FORGING_PAGES = [
    {
        name: "patches the built-ins before the read",
        path: "/patched-before.html",
        controls: NOT_DRAWN_CONTROL,
        script: `${customElementWith("get disabled() { return true; }")}${PATCHES_THE_BUILT_INS}`,
    },
    {
        name: "patches the built-ins from its disabled getter, during the read",
        path: "/patched-during.html",
        controls: NOT_DRAWN_CONTROL,
        script: customElementWith(`get disabled() { ${PATCHES_THE_BUILT_INS} return true; }`),
    },
];

const HIDES_A_PASSWORD_FIELD = {
    path: "/patched-holding-a-password-field.html",
    route: pageWith(
        CONTROL_HOLDING_A_PASSWORD_FIELD,
        customElementWith(`get disabled() { ${PATCHES_THE_BUILT_INS} return false; }`),
    ),
};

const ROUTES = new Map<string, FixtureRoute>([
    ...[...DISABLED_CUSTOM_ELEMENTS, ...ENABLED_CUSTOM_ELEMENTS, ...ORDINARY_ELEMENTS].map(
        ({ path, route }) => [path, route] as const,
    ),
    ...FORGING_PAGES.map(
        ({ path, controls, script }) => [path, pageWith(controls, script)] as const,
    ),
    [HIDES_A_PASSWORD_FIELD.path, HIDES_A_PASSWORD_FIELD.route],
]);

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
});
after(async () => {
    await harness.close();
});

const readOf = async (path: string) => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(path))).ok, `${path} loads`);
        const first = expectOneElement(await session.probe(harness.locator(testId(CONTROL))));
        const second = expectOneElement(await session.probe(harness.locator(testId(CONTROL))));
        return { first, second };
    } finally {
        await session.close();
    }
};

const clickOn = async (path: string) => {
    const session = await harness.openOwn(TARGET);
    try {
        assert.ok((await session.navigate(harness.url(path))).ok, `${path} loads`);
        const acted = await session.act(
            harness.actionStep(click(testId(CONTROL))),
            allowEveryAction,
        );
        return {
            failure: acted.ok ? null : acted.error,
            tally: await shownText(harness, session, TALLY),
        };
    } finally {
        await session.close();
    }
};

const everythingButEnabled = (read: OneElementRead) => ({
    count: read.count,
    visible: read.visible,
    text: read.text,
    value: read.value,
    sensitive: read.sensitive,
    box: read.box,
});

const assertReadsAndClicksAsEnabled = async (path: string): Promise<void> => {
    const { first } = await readOf(path);
    assert.equal(first.enabled, true);
    assert.deepEqual(await clickOn(path), { failure: null, tally: "1" });
};

describe("Using the real browser driver", () => {
    for (const { name, path } of DISABLED_CUSTOM_ELEMENTS) {
        describe(`given a custom element that ${name}`, () => {
            describe("when a plan reads it", () => {
                test("then it should read as not enabled", async () => {
                    const { first } = await readOf(path);
                    assert.equal(first.enabled, false);
                });
            });

            describe("when a plan clicks it", () => {
                test("then it should fail the step as not enabled, with no click sent", async () => {
                    const { failure, tally } = await clickOn(path);
                    assert.equal(failure?.code, "not-actionable");
                    assert.match(failure.detail, /not enabled/);
                    assert.equal(tally, "0");
                });
            });
        });
    }

    for (const { name, path } of ENABLED_CUSTOM_ELEMENTS) {
        describe(`given a custom element that ${name}`, () => {
            describe("when a plan reads and clicks it", () => {
                test("then it should read as enabled and pass the step", async () => {
                    await assertReadsAndClicksAsEnabled(path);
                });
            });
        });
    }

    for (const { name, path } of ORDINARY_ELEMENTS) {
        describe(`given an element that is not a custom element, with ${name}`, () => {
            describe("when a plan reads and clicks it", () => {
                test("then it should read as enabled and pass the step", async () => {
                    await assertReadsAndClicksAsEnabled(path);
                });
            });
        });
    }

    for (const { name, path } of FORGING_PAGES) {
        describe(`given a page that ${name}`, () => {
            describe("and a custom element that is disabled and not drawn", () => {
                describe("when a plan reads it twice", () => {
                    test("then it should read as not enabled each time", async () => {
                        const { first, second } = await readOf(path);
                        assert.deepEqual(
                            { first: first.enabled, second: second.enabled },
                            { first: false, second: false },
                        );
                    });

                    test("then it should report the rest as it is each time, and nothing the page wrote", async () => {
                        const { first, second } = await readOf(path);
                        assert.deepEqual(everythingButEnabled(first), NOT_DRAWN_FIELDS);
                        assert.deepEqual(everythingButEnabled(second), NOT_DRAWN_FIELDS);
                    });
                });
            });
        });
    }

    describe("given a page that patches the built-ins from its disabled getter", () => {
        describe("and a custom element that holds a password field", () => {
            describe("when a plan reads it twice", () => {
                test("then it should stay sensitive each time", async () => {
                    const { first, second } = await readOf(HIDES_A_PASSWORD_FIELD.path);
                    assert.deepEqual(
                        { first: first.sensitive, second: second.sensitive },
                        { first: true, second: true },
                    );
                });
            });
        });
    });
});
