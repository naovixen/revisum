// A web component draws its content inside a shadow root, and what it draws is as personal, and as
// clickable, as anything else on the page. So a capture must mask personal data inside open roots,
// the sensitive read must see across a root's edge in both directions, and the guard must judge what
// a click activates inside one. The pages use declarative shadow roots, so they are there on load.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SENSITIVE_PLACEHOLDER } from "@revisum/engine";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    capture,
    click,
    navigate,
    role,
    testId,
    textEquals,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { decodePng } from "#test-support/png-decoder.ts";
import { TARGET, htmlPage, routedPagesHarness } from "./RoutedPagesHarness.ts";

shareBrowserInThisFile();

// Long enough for a click under load, while a check that fails waits it out only a few times.
const STEP_TIMEOUT_MILLISECONDS = 2000;
const SHOT = "account-panel";
const PAGE_TITLE = "page-title";
const HOLDER = "holder";
const STATE = "page-state";
const UNTOUCHED = "Untouched";
const CLICKED = "Clicked";
const FIRST_HOLDER = "Ada Lovelace";
const SECOND_HOLDER = "Wim Wouters";

const shadowHost = (content: string): string =>
    `<checkout-panel><template shadowrootmode="open">${content}</template></checkout-panel>`;

const ROOTS: readonly { readonly name: string; readonly around: (content: string) => string }[] = [
    { name: "an open shadow root", around: shadowHost },
    {
        name: "an open shadow root inside another",
        around: (content) => shadowHost(shadowHost(content)),
    },
];

const titled = (body: string): FixtureRoute =>
    htmlPage(`<h1 data-testid="${PAGE_TITLE}">Account</h1>${body}`);

// Padded because a capital's stroke can reach just past the box of its own text, where no mask of
// the element covers it.
const TEXT_STYLE = "font-size:32px;width:600px;padding:8px";
const privateText = (holder: string): string =>
    `<p data-private style="${TEXT_STYLE}">${holder}</p>`;
const plainText = (holder: string): string => `<p style="${TEXT_STYLE}">${holder}</p>`;
const privateInput = (holder: string): string =>
    `<input type="email" value="${holder.replace(" ", ".")}@example.test" style="font-size:32px;width:600px">`;

const MASKED_CONTENTS: readonly {
    readonly name: string;
    readonly of: (holder: string) => string;
}[] = [
    { name: "text marked private", of: privateText },
    { name: "an email input", of: privateInput },
];

const holderIn = (attributes = ""): string =>
    `<p data-testid="${HOLDER}" ${attributes}>${FIRST_HOLDER}</p>`;

// Each arrangement of the element and what makes it sensitive, across a root's edge or not. `around`
// puts content inside the root under test.
const SENSITIVE_ARRANGEMENTS: readonly {
    readonly name: string;
    readonly page: (around: (content: string) => string) => string;
}[] = [
    {
        name: "the element itself is private",
        page: (around) => around(holderIn("data-private")),
    },
    {
        name: "an ancestor in the same root is private",
        page: (around) => around(`<div data-private>${holderIn()}</div>`),
    },
    {
        name: "an ancestor outside the root is private",
        page: (around) => `<div data-private>${around(holderIn())}</div>`,
    },
    {
        name: "a descendant inside a root is private",
        page: (around) =>
            `<section data-testid="${HOLDER}">${FIRST_HOLDER}${around("<p data-private>Card ending 4242</p>")}</section>`,
    },
];

const pageForClicks = (body: string): FixtureRoute =>
    htmlPage(`<p data-testid="${STATE}">${UNTOUCHED}</p>
      <script>
        const showClicked = () => { document.querySelector('[data-testid="${STATE}"]').textContent = '${CLICKED}'; };
      </script>
      ${body}`);

const buttonNamed = (name: string, inside = ""): string =>
    `<button type="button" onclick="showClicked()">${name}${inside}</button>`;
const wrapperAround = (content: string): string =>
    `<div data-testid="wrapper" role="group" aria-label="Account actions" style="display:inline-block">${content}</div>`;
const ICON = `<span data-testid="icon" role="img" aria-label="Information">(i)</span>`;

// Each click, whether it ends up on Delete, and how the page is laid out around the root.
const CLICKS: readonly {
    readonly name: string;
    readonly isDestructive: boolean;
    readonly locator: JsonRecord;
    readonly page: (around: (content: string) => string) => string;
}[] = [
    {
        name: "a plain button found by its role and name",
        isDestructive: false,
        locator: role("button", "Save"),
        page: (around) => around(buttonNamed("Save")),
    },
    {
        name: "a plain button found by its test id",
        isDestructive: false,
        locator: testId("save"),
        page: (around) =>
            around(
                `<button type="button" data-testid="save" onclick="showClicked()">Save</button>`,
            ),
    },
    {
        name: "a harmless wrapper around a Delete button, both in the root",
        isDestructive: true,
        locator: testId("wrapper"),
        page: (around) => around(wrapperAround(buttonNamed("Delete"))),
    },
    {
        name: "a harmless wrapper around a harmless button, both in the root",
        isDestructive: false,
        locator: testId("wrapper"),
        page: (around) => around(wrapperAround(buttonNamed("Show details"))),
    },
    {
        name: "a harmless wrapper outside the root, around a Delete button in it",
        isDestructive: true,
        locator: testId("wrapper"),
        page: (around) => wrapperAround(around(buttonNamed("Delete"))),
    },
    {
        name: "a harmless wrapper outside the root, around a harmless button in it",
        isDestructive: false,
        locator: testId("wrapper"),
        page: (around) => wrapperAround(around(buttonNamed("Show details"))),
    },
    {
        name: "a named icon inside a Delete button in the root",
        isDestructive: true,
        locator: testId("icon"),
        page: (around) => around(buttonNamed("Delete account ", ICON)),
    },
    {
        name: "a named icon inside a harmless button in the root",
        isDestructive: false,
        locator: testId("icon"),
        page: (around) => around(buttonNamed("Show details ", ICON)),
    },
    {
        name: "a Delete button only the page names, found by its test id",
        isDestructive: true,
        locator: testId("row-action"),
        page: (around) =>
            around(
                `<button type="button" data-testid="row-action" onclick="showClicked()">Delete</button>`,
            ),
    },
];

const maskPath = (root: number, content: number, holder: string): string =>
    `/mask-${root}-${content}-${holder.split(" ")[0]}.html`;
const plainPath = (root: number, holder: string): string =>
    `/plain-${root}-${holder.split(" ")[0]}.html`;
const sensitivePath = (root: number, arrangement: number): string =>
    `/sensitive-${root}-${arrangement}.html`;
const clickPath = (root: number, clicked: number): string => `/click-${root}-${clicked}.html`;

function routesForEveryCase(): ReadonlyMap<string, FixtureRoute> {
    const routes = new Map<string, FixtureRoute>();
    ROOTS.forEach(({ around }, root) => {
        for (const holder of [FIRST_HOLDER, SECOND_HOLDER]) {
            MASKED_CONTENTS.forEach(({ of }, content) => {
                routes.set(maskPath(root, content, holder), titled(around(of(holder))));
            });
            routes.set(plainPath(root, holder), titled(around(plainText(holder))));
        }
        SENSITIVE_ARRANGEMENTS.forEach(({ page }, arrangement) => {
            routes.set(sensitivePath(root, arrangement), titled(page(around)));
        });
        routes.set(`/not-sensitive-${root}.html`, titled(around(holderIn())));
        CLICKS.forEach(({ page }, clicked) => {
            routes.set(clickPath(root, clicked), pageForClicks(page(around)));
        });
    });
    return routes;
}

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        routes: routesForEveryCase(),
    });
});
after(async () => {
    await harness.close();
});

async function capturedPixels(path: string): Promise<Uint8Array> {
    const ran = await harness.runSteps(TARGET, [
        navigate(path),
        capture(SHOT),
        visible(testId(PAGE_TITLE), "page.title-shown"),
    ]);
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
    const bytes = ran.store.get(`${TARGET}/${SHOT}.png`);
    assert.ok(bytes !== undefined, "the capture was stored");
    return decodePng(bytes).data;
}

const differingBytes = (first: Uint8Array, second: Uint8Array): number => {
    assert.equal(first.length, second.length, "the two captures have the same size");
    return first.filter((byte, index) => byte !== second[index]).length;
};

// What the page's probe reports of the holder, read as the run ends, with no check to wait out.
async function probedHolder(path: string) {
    const seen: { sensitive?: boolean; count?: unknown } = {};
    await harness.runSteps(
        TARGET,
        [navigate(path), visible(testId(PAGE_TITLE), "page.title-shown")],
        {
            read: [],
            beforePageRead: async (session) => {
                const probe = await session.probe(harness.locator(testId(HOLDER)));
                seen.sensitive = probe.sensitive;
                seen.count = probe.count;
            },
        },
    );
    return seen;
}

const WRONG_HOLDER_CHECK = textEquals(testId(HOLDER), "Someone else", "holder.name-shown");

describe("Using a run in a real browser", () => {
    ROOTS.forEach(({ name: rootName }, root) => {
        MASKED_CONTENTS.forEach(({ name: contentName }, content) => {
            describe(`given ${contentName} in ${rootName}`, () => {
                describe("when the page is captured with two different holders", () => {
                    test("then it should show the same pixels", async () => {
                        const first = await capturedPixels(maskPath(root, content, FIRST_HOLDER));
                        const second = await capturedPixels(maskPath(root, content, SECOND_HOLDER));
                        assert.equal(differingBytes(first, second), 0);
                    });
                });
            });
        });

        describe(`given text not marked private in ${rootName}`, () => {
            describe("when the page is captured with two different holders", () => {
                test("then it should show the difference", async () => {
                    const first = await capturedPixels(plainPath(root, FIRST_HOLDER));
                    const second = await capturedPixels(plainPath(root, SECOND_HOLDER));
                    assert.ok(differingBytes(first, second) > 0, "the captures are identical");
                });
            });
        });

        SENSITIVE_ARRANGEMENTS.forEach(({ name: arrangementName }, arrangement) => {
            describe(`given an element in ${rootName} where ${arrangementName}`, () => {
                describe("when the page probes it", () => {
                    test("then it should read as sensitive", async () => {
                        assert.deepEqual(await probedHolder(sensitivePath(root, arrangement)), {
                            sensitive: true,
                            count: 1,
                        });
                    });
                });
            });
        });

        describe(`given an element in ${rootName} with nothing private on it or around it`, () => {
            describe("when the page probes it", () => {
                test("then it should not read as sensitive", async () => {
                    assert.deepEqual(await probedHolder(`/not-sensitive-${root}.html`), {
                        sensitive: false,
                        count: 1,
                    });
                });
            });

            describe("when a check of its text fails", () => {
                test("then it should keep what it observed", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate(`/not-sensitive-${root}.html`),
                        WRONG_HOLDER_CHECK,
                    ]);
                    assert.equal(result.steps[1]?.observed, FIRST_HOLDER);
                });
            });
        });

        describe(`given a private element in ${rootName}`, () => {
            describe("when a check of its text fails", () => {
                test("then it should keep the placeholder and none of the text", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate(sensitivePath(root, 0)),
                        WRONG_HOLDER_CHECK,
                    ]);
                    assert.equal(result.steps[1]?.code, "assertion-failed");
                    assert.equal(result.steps[1]?.observed, SENSITIVE_PLACEHOLDER);
                    assert.equal(JSON.stringify(result).includes(FIRST_HOLDER), false);
                });
            });
        });

        CLICKS.forEach(({ name, isDestructive, locator }, clicked) => {
            describe(`given ${name}, in ${rootName}`, () => {
                describe("when a plan clicks it", () => {
                    const expectation = isDestructive
                        ? "then it should be denied and the button should not be pressed"
                        : "then it should press the button";
                    test(expectation, async () => {
                        const expected = isDestructive ? UNTOUCHED : CLICKED;
                        const ran = await harness.runSteps(
                            TARGET,
                            [
                                navigate(clickPath(root, clicked)),
                                click(locator),
                                textEquals(testId(STATE), expected, "page.state-read"),
                            ],
                            { read: [STATE] },
                        );
                        assert.deepEqual(
                            {
                                state: ran.result.state,
                                denial: ran.result.denial,
                                shown: ran.atClose?.shown[STATE],
                            },
                            isDestructive
                                ? {
                                      state: "Denied",
                                      denial: { rule: "irreversible-action", stepIndex: 1 },
                                      shown: UNTOUCHED,
                                  }
                                : { state: "Passed", denial: undefined, shown: CLICKED },
                        );
                    });
                });
            });
        });
    });
});
