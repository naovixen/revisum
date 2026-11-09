// The runtime guard is told what the page really names and links to, in a real browser. A form's
// submit control is named however the browser names it: by a title, a label or the alt text of an
// image inside it, so Enter in a field cannot submit a form whose only submit control says Delete.
// A link is a link however the page draws it: an SVG link and an image-map area lead somewhere just
// as an HTML link does, so the project's destructive paths apply to them. Each denial is paired with
// the same page under a harmless name or path, which does go through.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    navigate,
    press,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    capabilityDrivers,
    capabilityPlan,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STATE = "page-state";
const UNTOUCHED = "Untouched";
const SUBMITTED = "Submitted";
const DELETED = "Deleted";
const SETTINGS = "Settings";
const DESTRUCTIVE_PATH = "/account/delete";
const HARMLESS_PATH = "/account/settings";

const htmlPage = (body: string): FixtureRoute => {
    return () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>${body}</main></body></html>`,
    });
};

const pageShowing = (state: string): FixtureRoute =>
    htmlPage(`<p data-testid="${STATE}">${state}</p>`);

const pageWith = (body: string): FixtureRoute =>
    htmlPage(`<p data-testid="${STATE}">${UNTOUCHED}</p>${body}`);

// A form with one field named Reason, whose only submit control is `submit`. A submit shows on the
// page and never leaves it.
const formWith = (submit: string): FixtureRoute =>
    pageWith(`<form>
        <input aria-label="Reason" type="text">
        ${submit}
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.querySelector('[data-testid="${STATE}"]').textContent = '${SUBMITTED}';
        });
      </script>`);

const SMALL_IMAGE = "/small-image.svg";

const submitNamedByNestedImage = (name: string): string =>
    `<button><img alt="${name}" src="${SMALL_IMAGE}" width="16" height="16"></button>`;
const submitNamedByTitle = (name: string): string =>
    `<button title="${name}"><svg width="16" height="16"></svg></button>`;
const submitNamedByLabel = (name: string): string =>
    `<label for="named-by-label">${name}</label><button id="named-by-label"><svg width="16" height="16"></svg></button>`;

type SubmitWriting = {
    readonly written: string;
    readonly submit: (name: string) => string;
    readonly destructivePage: string;
    readonly harmlessPage: string;
};

const SUBMIT_WRITINGS: readonly SubmitWriting[] = [
    {
        written: "the alt text of an image inside it",
        submit: submitNamedByNestedImage,
        destructivePage: "/submit-image-delete.html",
        harmlessPage: "/submit-image-update.html",
    },
    {
        written: "its title",
        submit: submitNamedByTitle,
        destructivePage: "/submit-title-delete.html",
        harmlessPage: "/submit-title-update.html",
    },
    {
        written: "a label pointing at it",
        submit: submitNamedByLabel,
        destructivePage: "/submit-label-delete.html",
        harmlessPage: "/submit-label-update.html",
    },
];

const svgLinkTo = (path: string): string =>
    `<svg width="200" height="100"><a data-testid="drawn-link" href="${path}"><text x="10" y="60" font-size="48">Go</text></a></svg>`;

// The driver can reach an area only through something around both it and its image: an area has no
// box of its own, and to the browser's hit test it is not inside the image. The whole image is the
// area, so the middle of the wrapper is the area.
const imageMapTo = (path: string): string =>
    `<div data-testid="drawn-link" role="group" aria-label="Site map" style="display:inline-block">
       <img alt="" usemap="#places" width="200" height="100" src="${SMALL_IMAGE}" style="display:block">
       <map name="places"><area shape="rect" coords="0,0,200,100" href="${path}" alt="Go"></map>
     </div>`;

type LinkDrawing = {
    readonly drawn: string;
    readonly destructivePage: string;
    readonly harmlessPage: string;
};

const LINK_DRAWINGS: readonly LinkDrawing[] = [
    {
        drawn: "an SVG link",
        destructivePage: "/svg-link-delete.html",
        harmlessPage: "/svg-link-settings.html",
    },
    {
        drawn: "an image-map area",
        destructivePage: "/image-map-delete.html",
        harmlessPage: "/image-map-settings.html",
    },
];

const IRREVERSIBLE_NAME = "Delete account";
const HARMLESS_NAME = "Update profile";

const ROUTES = new Map<string, FixtureRoute>([
    [
        SMALL_IMAGE,
        () => ({
            headers: { "content-type": "image/svg+xml" },
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>`,
        }),
    ],
    [DESTRUCTIVE_PATH, pageShowing(DELETED)],
    [HARMLESS_PATH, pageShowing(SETTINGS)],
    ...SUBMIT_WRITINGS.flatMap(
        ({ submit, destructivePage, harmlessPage }): [string, FixtureRoute][] => [
            [destructivePage, formWith(submit(IRREVERSIBLE_NAME))],
            [harmlessPage, formWith(submit(HARMLESS_NAME))],
        ],
    ),
    ["/svg-link-delete.html", pageWith(svgLinkTo(DESTRUCTIVE_PATH))],
    ["/svg-link-settings.html", pageWith(svgLinkTo(HARMLESS_PATH))],
    ["/image-map-delete.html", pageWith(imageMapTo(DESTRUCTIVE_PATH))],
    ["/image-map-settings.html", pageWith(imageMapTo(HARMLESS_PATH))],
]);

let harness: BrowserHarness;
before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: ROUTES,
        projectFile: (origin) => ({
            origins: [origin],
            limits: { stepTimeoutMilliseconds: 2000 },
            matrix: englishMatrix(Object.values(BrowserTarget)),
            policy: { destructiveUrlPatterns: [DESTRUCTIVE_PATH] },
        }),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: capabilityDrivers(),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
});

const runActing = async (page: string, action: JsonRecord, shownAfterwards: string) => {
    const ran = await harness.runSteps(
        TARGET,
        [navigate(page), action, textEquals(testId(STATE), shownAfterwards, "page.state-read")],
        { read: [STATE] },
    );
    return {
        state: ran.result.state,
        denial: ran.result.denial,
        shown: ran.atClose?.shown[STATE],
    };
};

const ENTER_IN_REASON = press(role("textbox", "Reason"), "Enter");
const CLICK_DRAWN_LINK = click(testId("drawn-link"));

describe("Using the runtime guard in a real browser", () => {
    for (const { written, destructivePage, harmlessPage } of SUBMIT_WRITINGS) {
        describe(`given a form whose submit control is named ${IRREVERSIBLE_NAME} only by ${written}`, () => {
            describe("when a plan presses Enter in its field", () => {
                test("then it should be denied as an irreversible submit and nothing should be submitted", async () => {
                    assert.deepEqual(await runActing(destructivePage, ENTER_IN_REASON, UNTOUCHED), {
                        state: "Denied",
                        denial: { rule: "irreversible-submit", stepIndex: 1 },
                        shown: UNTOUCHED,
                    });
                });
            });
        });

        describe(`given a form whose submit control is named ${HARMLESS_NAME} only by ${written}`, () => {
            describe("when a plan presses Enter in its field", () => {
                test("then it should submit the form", async () => {
                    assert.deepEqual(await runActing(harmlessPage, ENTER_IN_REASON, SUBMITTED), {
                        state: "Passed",
                        denial: undefined,
                        shown: SUBMITTED,
                    });
                });
            });
        });
    }

    for (const { drawn, destructivePage, harmlessPage } of LINK_DRAWINGS) {
        describe(`given ${drawn} to a destructive path`, () => {
            describe("when a plan clicks it", () => {
                test("then it should be denied as a destructive navigation and the page should not change", async () => {
                    assert.deepEqual(
                        await runActing(destructivePage, CLICK_DRAWN_LINK, UNTOUCHED),
                        {
                            state: "Denied",
                            denial: { rule: "destructive-navigation", stepIndex: 1 },
                            shown: UNTOUCHED,
                        },
                    );
                });
            });
        });

        describe(`given ${drawn} to another path`, () => {
            describe("when a plan clicks it", () => {
                test("then it should follow the link", async () => {
                    assert.deepEqual(await runActing(harmlessPage, CLICK_DRAWN_LINK, SETTINGS), {
                        state: "Passed",
                        denial: undefined,
                        shown: SETTINGS,
                    });
                });
            });
        });
    }
});
