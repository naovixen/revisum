// The oracle's page checks, and what it asks a probe to read. The browser's own error page keeps the
// URL it wanted, so it must fail every page check however well that URL fits.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    checkPage,
    domReadFor,
    normalise,
    planParser,
    type PageAssertion,
    type PageProbe,
    type Verdict,
} from "@revisum/engine";
import {
    BASE_URL,
    FAILED,
    ORDERS_URL,
    PASSED,
    VISIBLE,
    safe,
    verdictName,
} from "./ShownElement.ts";
import { parsedProject } from "./unsafe-feature-examples.ts";
import { unsafePlan, unsafeProjectFile, type JsonRecord } from "./unsafe-feature-steps.ts";

// Parsed by the real parser, since only it may brand a page check's URL.
function parsedPageAssertion(
    raw: JsonRecord,
    earlierSteps: readonly JsonRecord[] = [],
): PageAssertion {
    const parse = planParser(parsedProject(unsafeProjectFile()));
    const parsed = parse(
        unsafePlan([
            { type: "navigate", url: "/orders" },
            ...earlierSteps,
            { type: "expectPage", assert: raw, criterionId: "orders.page-checked" },
        ]),
    );
    assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
    const step = parsed.value.steps[1 + earlierSteps.length];
    assert.ok(step?.type === "expectPage");
    return step.assert;
}

const PAGE: PageProbe = { url: `${ORDERS_URL}/7?tab=items#top`, title: "Your  orders" };
const META_NAME = "og:title";
const WITH_HEAD: PageProbe = {
    ...PAGE,
    meta: [{ name: "OG:Title", content: " Your  orders " }],
    canonicalUrl: ORDERS_URL,
};

const PAGE_CASES: readonly {
    readonly check: string;
    readonly assertion: () => PageAssertion;
    readonly cases: readonly {
        readonly probe: string;
        readonly seen: PageProbe;
        readonly verdict: Verdict;
    }[];
}[] = [
    {
        check: "a urlPath",
        assertion: () => parsedPageAssertion({ kind: "urlPath", value: "/orders/7" }),
        cases: [
            { probe: "a page on that path", seen: PAGE, verdict: PASSED },
            {
                probe: "a page on another path",
                seen: { ...PAGE, url: ORDERS_URL },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "a title",
        assertion: () => parsedPageAssertion({ kind: "title", value: "Your orders" }),
        cases: [
            { probe: "that title, spaced differently", seen: PAGE, verdict: PASSED },
            { probe: "another title", seen: { ...PAGE, title: "Your cart" }, verdict: FAILED },
        ],
    },
    {
        check: "a url given as a path",
        assertion: () => parsedPageAssertion({ kind: "url", value: "/orders" }),
        cases: [
            { probe: "a page at that URL", seen: { ...PAGE, url: ORDERS_URL }, verdict: PASSED },
            { probe: "a page with a query as well", seen: PAGE, verdict: FAILED },
        ],
    },
    {
        check: "a urlPathStartsWith",
        assertion: () => parsedPageAssertion({ kind: "urlPathStartsWith", value: "/orders/" }),
        cases: [
            { probe: "a page under it", seen: PAGE, verdict: PASSED },
            { probe: "a page above it", seen: { ...PAGE, url: ORDERS_URL }, verdict: FAILED },
        ],
    },
    {
        check: "a metaContent",
        assertion: () =>
            parsedPageAssertion({ kind: "metaContent", name: META_NAME, value: "Your orders" }),
        cases: [
            { probe: "that tag, in another case and spacing", seen: WITH_HEAD, verdict: PASSED },
            {
                probe: "another tag",
                seen: { ...PAGE, meta: [{ name: "description", content: "Your orders" }] },
                verdict: FAILED,
            },
            {
                probe: "that tag with other content",
                seen: { ...PAGE, meta: [{ name: META_NAME, content: "Your cart" }] },
                verdict: FAILED,
            },
            { probe: "a head with no tags", seen: { ...PAGE, meta: [] }, verdict: FAILED },
            { probe: "no read of the head", seen: PAGE, verdict: FAILED },
        ],
    },
    {
        check: "a metaContent still holding a value reference",
        assertion: () =>
            parsedPageAssertion(
                { kind: "metaContent", name: META_NAME, value: { valueName: "shownTitle" } },
                [
                    {
                        type: "remember",
                        name: "shownTitle",
                        from: { element: { by: "testId", testId: "title" }, read: "text" },
                    },
                ],
            ),
        cases: [{ probe: "a tag holding anything", seen: WITH_HEAD, verdict: FAILED }],
    },
    {
        check: "a canonicalUrl given as a path",
        assertion: () => parsedPageAssertion({ kind: "canonicalUrl", value: "/orders" }),
        cases: [
            { probe: "that canonical link", seen: WITH_HEAD, verdict: PASSED },
            {
                probe: "another canonical link",
                seen: { ...WITH_HEAD, canonicalUrl: `${BASE_URL}/cart` },
                verdict: FAILED,
            },
            {
                probe: "a head with no canonical link",
                seen: { ...WITH_HEAD, canonicalUrl: null },
                verdict: FAILED,
            },
            { probe: "no read of the head", seen: PAGE, verdict: FAILED },
        ],
    },
];

describe("Using the oracle", () => {
    for (const { check, assertion, cases } of PAGE_CASES) {
        for (const { probe, seen, verdict } of cases) {
            describe(`given ${check} check and ${probe}`, () => {
                describe("when the page is judged", () => {
                    test(`then it should give ${verdictName(verdict)}`, () => {
                        assert.deepEqual(checkPage(assertion(), seen, BASE_URL), verdict);
                    });
                });
            });
        }
    }

    describe("given a canonicalUrl check of a path and no base URL", () => {
        describe("when the page is judged", () => {
            test("then it should fail, since the path can't be read as a URL", () => {
                assert.deepEqual(
                    checkPage(
                        parsedPageAssertion({ kind: "canonicalUrl", value: "/orders" }),
                        WITH_HEAD,
                    ),
                    FAILED,
                );
            });
        });
    });

    for (const { check, assertion } of PAGE_CASES) {
        describe(`given ${check} check and the browser's own error page`, () => {
            describe("when the page is judged", () => {
                test("then it should fail with navigation-failed", () => {
                    assert.deepEqual(
                        checkPage(assertion(), { ...WITH_HEAD, browserErrorPage: true }, BASE_URL),
                        { pass: false, code: "navigation-failed" },
                    );
                });
            });
        });
    }

    describe("given each kind of check", () => {
        describe("when asked what the probe must read of the element", () => {
            test("then it should name the DOM read of a DOM check and nothing for any other", () => {
                assert.deepEqual(domReadFor({ kind: "hasClass", value: safe("on") }), {
                    kind: "classes",
                });
                assert.deepEqual(domReadFor({ kind: "lacksClass", value: safe("on") }), {
                    kind: "classes",
                });
                assert.deepEqual(
                    domReadFor({
                        kind: "computedStyleEquals",
                        property: safe("color"),
                        value: safe("red"),
                    }),
                    { kind: "computedStyle", property: "color" },
                );
                assert.deepEqual(
                    domReadFor({ kind: "attributeEquals", name: safe("title"), value: safe("x") }),
                    { kind: "attribute", name: "title" },
                );
                assert.deepEqual(domReadFor({ kind: "attributeAbsent", name: safe("title") }), {
                    kind: "attribute",
                    name: "title",
                });
                assert.equal(domReadFor(VISIBLE), undefined);
            });
        });
    });

    describe("given text with runs of white space", () => {
        describe("when it is normalised", () => {
            test("then it should collapse each run to one space and trim the ends", () => {
                assert.equal(normalise("  Order\n\t placed  "), "Order placed");
            });
        });
    });
});
