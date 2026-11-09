// The Tab walk and the reflow probe measure inside the page's own world, where a page can patch what
// they call, so what comes back is outside data. An answer that makes no sense must stop the scan: left
// unmeasured, an element would say nothing, and the page would pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    ALL_RULES,
    isStaticRule,
    scan,
    tabWalk,
    type PageDriver,
    type PageSnapshot,
    type SnapshotNode,
} from "@revisum/auditor-act";

const ROOT_BACKEND_ID = 1;
const BUTTON_BACKEND_ID = 2;
const BUTTON_INDEX = 1;
const PAGE_URL = "http://127.0.0.1/page.html";
const PAGE_WIDTH = 1024;
const PAGE_HEIGHT = 768;
const NARROW_WIDTH = 320;
const NARROW_HEIGHT = 256;
const OCCLUSION_RULE = "keyboard-focus-obscured";
const REFLOW_RULE = "page-reflow";

const elementNode = (
    index: number,
    backendId: number,
    name: string,
    parent: number,
    children: readonly number[],
): SnapshotNode => ({
    index,
    backendId,
    nodeType: 1,
    name,
    value: "",
    attributes: {},
    parent,
    children: [...children],
    document: 0,
    shadowHost: -1,
    contentDocument: -1,
    style: { display: "block", visibility: "visible" },
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    accessibility: null,
});

const SNAPSHOT: PageSnapshot = {
    url: PAGE_URL,
    nodes: [
        elementNode(0, ROOT_BACKEND_ID, "html", -1, [BUTTON_INDEX]),
        elementNode(BUTTON_INDEX, BUTTON_BACKEND_ID, "button", 0, []),
    ],
    roots: [0],
    viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
};

// A page with one button, which gives every script run in it the same answer. Tab reaches the button,
// then leaves the page.
function pageAnswering(answer: unknown): {
    readonly page: PageDriver;
    readonly viewports: readonly (readonly [number, number])[];
} {
    const viewports: (readonly [number, number])[] = [];
    let presses = 0;
    const page: PageDriver = {
        goto: () => Promise.resolve(),
        snapshot: () => Promise.resolve(SNAPSHOT),
        pressKey: () => {
            presses += 1;
            return Promise.resolve();
        },
        activeElement: () =>
            Promise.resolve(
                presses === 1
                    ? {
                          backendId: BUTTON_BACKEND_ID,
                          box: { x: 0, y: 0, width: 100, height: 40 },
                      }
                    : null,
            ),
        screenshotClip: () => Promise.resolve(""),
        screenshot: () => Promise.resolve(""),
        authorDeclaredProperties: () => Promise.resolve([]),
        focusBackend: () => Promise.resolve(false),
        sampleBackground: () => Promise.resolve(null),
        evaluate: () => Promise.resolve(answer),
        setViewport: (width, height) => {
            viewports.push([width, height]);
            return Promise.resolve();
        },
        close: () => Promise.resolve(),
    };
    return { page, viewports };
}

const inheriting = (fields: object): unknown => Object.create(fields);

const NOT_A_MEASURE: readonly { readonly name: string; readonly answer: unknown }[] = [
    { name: "null", answer: null },
    { name: "nothing", answer: undefined },
    { name: "text", answer: "fine" },
    { name: "a number", answer: 25 },
    { name: "a list", answer: [] },
    { name: "an empty object", answer: {} },
];

const WHOLE_MEASURE = { inView: true, hits: 25, total: 25 };

const MALFORMED_OCCLUSIONS: readonly { readonly name: string; readonly answer: unknown }[] = [
    ...NOT_A_MEASURE,
    { name: "an object inheriting its fields", answer: inheriting(WHOLE_MEASURE) },
    { name: "no inView", answer: { hits: 25, total: 25 } },
    { name: "no hits", answer: { inView: true, total: 25 } },
    { name: "no total", answer: { inView: true, hits: 25 } },
    { name: "inView as text", answer: { ...WHOLE_MEASURE, inView: "true" } },
    { name: "inView as a number", answer: { ...WHOLE_MEASURE, inView: 1 } },
    { name: "hits as text", answer: { ...WHOLE_MEASURE, hits: "25" } },
    { name: "hits as null", answer: { ...WHOLE_MEASURE, hits: null } },
    { name: "hits as NaN", answer: { ...WHOLE_MEASURE, hits: Number.NaN } },
    { name: "hits as infinity", answer: { ...WHOLE_MEASURE, hits: Number.POSITIVE_INFINITY } },
    { name: "hits as a fraction", answer: { ...WHOLE_MEASURE, hits: 2.5 } },
    { name: "total as text", answer: { ...WHOLE_MEASURE, total: "25" } },
    { name: "total as NaN", answer: { ...WHOLE_MEASURE, total: Number.NaN } },
    { name: "total as a fraction", answer: { ...WHOLE_MEASURE, total: 2.5 } },
];

const FITTING_WIDTHS = { scrollWidth: NARROW_WIDTH, clientWidth: NARROW_WIDTH };

const MALFORMED_WIDTHS: readonly { readonly name: string; readonly answer: unknown }[] = [
    ...NOT_A_MEASURE,
    { name: "an object inheriting its fields", answer: inheriting(FITTING_WIDTHS) },
    { name: "no scrollWidth", answer: { clientWidth: NARROW_WIDTH } },
    { name: "no clientWidth", answer: { scrollWidth: NARROW_WIDTH } },
    { name: "scrollWidth as text", answer: { ...FITTING_WIDTHS, scrollWidth: "320" } },
    { name: "scrollWidth as null", answer: { ...FITTING_WIDTHS, scrollWidth: null } },
    { name: "scrollWidth as NaN", answer: { ...FITTING_WIDTHS, scrollWidth: Number.NaN } },
    {
        name: "scrollWidth as infinity",
        answer: { ...FITTING_WIDTHS, scrollWidth: Number.POSITIVE_INFINITY },
    },
    { name: "clientWidth as text", answer: { ...FITTING_WIDTHS, clientWidth: "320" } },
    { name: "clientWidth as null", answer: { ...FITTING_WIDTHS, clientWidth: null } },
    { name: "clientWidth as NaN", answer: { ...FITTING_WIDTHS, clientWidth: Number.NaN } },
    {
        name: "clientWidth as infinity",
        answer: { ...FITTING_WIDTHS, clientWidth: Number.POSITIVE_INFINITY },
    },
];

const UNREADABLE_MEASURE = /unreadable measure of what covers the focused element/;
const UNREADABLE_WIDTHS = /unreadable widths for its document/;

const WALK_WITH_OCCLUSION = { focusVisibility: false, occlusion: true };

const scanFor = (answer: unknown, rule: string): Promise<unknown> =>
    scan(pageAnswering(answer).page, PAGE_URL, { rules: [rule], page: "/page.html" });

// What the rule says of each target, on a page walked as a scan walks it.
const outcomesOf = async (answer: unknown, ruleId: string): Promise<readonly string[]> => {
    const { page } = pageAnswering(answer);
    const walk = await tabWalk(page, SNAPSHOT, {
        focusVisibility: false,
        occlusion: ruleId === OCCLUSION_RULE,
    });
    const rule = ALL_RULES.find((candidate) => candidate.meta.id === ruleId);
    assert.ok(rule !== undefined && !isStaticRule(rule), `${ruleId} runs on a page`);
    const targets = await rule.run(page, SNAPSHOT, walk);
    return targets.map((target) => target.outcome);
};

describe("Using the Tab walk", () => {
    for (const { name, answer } of MALFORMED_OCCLUSIONS) {
        describe(`given a page that answers what covers the focused element with ${name}`, () => {
            describe("when the page is walked", () => {
                test("then it should reject, leaving nothing to read as a pass", async () => {
                    await assert.rejects(
                        tabWalk(pageAnswering(answer).page, SNAPSHOT, WALK_WITH_OCCLUSION),
                        UNREADABLE_MEASURE,
                    );
                });
            });

            describe("when the page is scanned", () => {
                test("then it should reject the scan", async () => {
                    await assert.rejects(scanFor(answer, OCCLUSION_RULE), UNREADABLE_MEASURE);
                });
            });
        });
    }

    describe("given a page that gives a measure that makes sense", () => {
        describe("when the page is walked", () => {
            test("then it should keep the measure of the focused element", async () => {
                const walk = await tabWalk(
                    pageAnswering(WHOLE_MEASURE).page,
                    SNAPSHOT,
                    WALK_WITH_OCCLUSION,
                );
                assert.deepEqual(walk.sequence, [BUTTON_INDEX]);
                assert.deepEqual(walk.obscured.get(BUTTON_INDEX), WHOLE_MEASURE);
            });
        });
    });

    describe("given a page whose focused element is on top at every point", () => {
        describe("when the page is scanned", () => {
            test("then it should pass the element", async () => {
                assert.deepEqual(await outcomesOf(WHOLE_MEASURE, OCCLUSION_RULE), ["passed"]);
            });
        });
    });

    describe("given a page whose focused element is on top at no point", () => {
        describe("when the page is scanned", () => {
            test("then it should fail the element", async () => {
                const covered = { inView: true, hits: 0, total: 25 };
                assert.deepEqual(await outcomesOf(covered, OCCLUSION_RULE), ["failed"]);
            });
        });
    });
});

describe("Using the reflow probe", () => {
    for (const { name, answer } of MALFORMED_WIDTHS) {
        describe(`given a page that answers its widths with ${name}`, () => {
            describe("when the page is scanned", () => {
                test("then it should reject the scan, leaving nothing to read as a pass", async () => {
                    await assert.rejects(scanFor(answer, REFLOW_RULE), UNREADABLE_WIDTHS);
                });

                test("then it should put the viewport back", async () => {
                    const { page, viewports } = pageAnswering(answer);
                    await assert.rejects(
                        scan(page, PAGE_URL, { rules: [REFLOW_RULE], page: "/page.html" }),
                        UNREADABLE_WIDTHS,
                    );
                    assert.deepEqual(viewports, [
                        [NARROW_WIDTH, NARROW_HEIGHT],
                        [PAGE_WIDTH, PAGE_HEIGHT],
                    ]);
                });
            });
        });
    }

    describe("given a page that fits the narrow width", () => {
        describe("when the page is scanned", () => {
            test("then it should pass the page", async () => {
                assert.deepEqual(await outcomesOf(FITTING_WIDTHS, REFLOW_RULE), ["passed"]);
            });
        });
    });

    describe("given a page wider than the narrow width", () => {
        describe("when the page is scanned", () => {
            test("then it should not pass the page", async () => {
                const wide = { scrollWidth: 900, clientWidth: NARROW_WIDTH };
                assert.deepEqual(await outcomesOf(wide, REFLOW_RULE), ["cantTell"]);
            });
        });
    });
});
