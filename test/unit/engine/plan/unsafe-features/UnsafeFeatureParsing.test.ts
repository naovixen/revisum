// The one plan parser reads which unsafe features the trusted project enables. A plan that uses
// a feature its project leaves off is refused with unsafe_feature_disabled at every path where the
// feature appears, echoing nothing from the plan, and nothing runs. Inline scripts need both page
// scripts and inline scripts enabled. A css selector or XPath expression is literal, single-line
// plan text of at most 512 characters with no "{", "}", ";" or "@", and an `inside` chain is at
// most 3 deep, so what a locator can match is fixed when the plan is approved.
import assert from "node:assert/strict";
import { arch, platform } from "node:os";
import { describe, test } from "node:test";
import { UntrustedRunOutcomeKind, createRunService } from "@revisum/engine";
import { PRIVATE_MARKER, defaultParser } from "../examples/GoldenPlan.ts";
import { spyDriver } from "../../secrets/examples/SecretRun.ts";
import { routedServiceCaller } from "../../run/executors/service-calls/examples/ShopService.ts";
import {
    acceptedBy,
    allBut,
    disabledPaths,
    errorsOf,
    parsedProject,
    parserEnabling,
    rejection,
} from "./examples/LostByFeature.ts";
import {
    ALL_FEATURES_PLAN,
    CSS_CHECK,
    FEATURES,
    FEATURE_EXAMPLES,
    INLINE_READ,
    OPEN_CART,
    ORIGIN,
    XPATH_CHECK,
    css,
    unsafePlan,
    unsafeProjectFile,
    xpath,
    type FeatureName,
    type JsonRecord,
    ALL_FEATURES_PATHS,
} from "./examples/UnsafePlan.ts";
import { fakePorts } from "#test-support/fakes/FakePorts.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";
import { StructuralLocatorKind } from "@revisum/contracts";

const NOTHING_ENABLED: readonly FeatureName[] = [];

// ---- One plan per feature, with that feature off ---------------------------------------------------

for (const example of FEATURE_EXAMPLES) {
    test(`a 1.3 plan using ${example.feature} is refused with unsafe_feature_disabled at ${example.path} when every other feature is on`, () => {
        const errors = errorsOf(parserEnabling(allBut(example.feature)), unsafePlan(example.steps));
        assert.deepEqual(disabledPaths(errors), [example.path]);
    });

    test(`a 1.3 plan using ${example.feature} is refused the same way when no feature is on`, () => {
        const errors = errorsOf(parserEnabling(NOTHING_ENABLED), unsafePlan(example.steps));
        assert.deepEqual(disabledPaths(errors), [example.path]);
    });

    // Counter-example: the plan itself is valid, so the refusal above comes from the project alone.
    test(`the same plan using ${example.feature} parses once the project enables it`, () => {
        acceptedBy(parserEnabling(FEATURES), unsafePlan(example.steps));
    });
}

test("an inline script is refused at .script.inline when page scripts are on but inline scripts are off", () => {
    const errors = errorsOf(
        parserEnabling(allBut("inline-page-script")),
        unsafePlan([OPEN_CART, INLINE_READ]),
    );
    assert.deepEqual(disabledPaths(errors), ["$.steps[1].script.inline"]);
    assert.ok(
        errors.every((error) => error.code === "unsafe_feature_disabled"),
        JSON.stringify(errors),
    );
});

test("an inline script is refused at .script.inline, and only there, when page scripts are off too", () => {
    const errors = errorsOf(
        parserEnabling(allBut("page-script")),
        unsafePlan([OPEN_CART, INLINE_READ]),
    );
    assert.deepEqual(disabledPaths(errors), ["$.steps[1].script.inline"]);
});

// Any object as a script is the inline form, even one without its own inline field, so the
// feature check and the reader agree on which form a script is.
const EMPTY_INLINE_READ: JsonRecord = { ...INLINE_READ, script: {} };

describe("Using the plan parser", () => {
    describe("given a step whose script is an empty object", () => {
        describe("and a project with inline scripts off", () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the script as an inline script, exactly as one written in full", () => {
                    const parse = parserEnabling(allBut("inline-page-script"));
                    assert.deepEqual(
                        rejection(parse, unsafePlan([OPEN_CART, EMPTY_INLINE_READ])),
                        rejection(parse, unsafePlan([OPEN_CART, INLINE_READ])),
                    );
                });
            });
        });

        describe("and a project with inline scripts on", () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the script as missing_field at .script.inline", () => {
                    assert.deepEqual(
                        rejection(
                            parserEnabling(FEATURES),
                            unsafePlan([OPEN_CART, EMPTY_INLINE_READ]),
                        ),
                        ["missing_field $.steps[1].script.inline"],
                    );
                });
            });
        });
    });

    describe("given a step with an inline script written in full", () => {
        describe("and a project with inline scripts off", () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse it with unsafe_feature_disabled at .script.inline alone", () => {
                    assert.deepEqual(
                        rejection(
                            parserEnabling(allBut("inline-page-script")),
                            unsafePlan([OPEN_CART, INLINE_READ]),
                        ),
                        ["unsafe_feature_disabled $.steps[1].script.inline"],
                    );
                });
            });
        });
    });
});

// ---- Every use, in one plan ----------------------------------------------------------------------

test("a plan using all six features under a project enabling none is refused at every use, nested and in cleanup included", () => {
    const errors = errorsOf(parserEnabling(NOTHING_ENABLED), ALL_FEATURES_PLAN());
    assert.deepEqual(disabledPaths(errors), [...ALL_FEATURES_PATHS].sort());
});

test("the same plan under a project with no unsafeFeatures section at all is refused at the same paths", () => {
    // The shared test project as it was before plan 1.3.
    const errors = errorsOf(defaultParser(), ALL_FEATURES_PLAN());
    assert.deepEqual(disabledPaths(errors), [...ALL_FEATURES_PATHS].sort());
});

test("two uses of one disabled feature are both reported, not only the first", () => {
    const plan = unsafePlan([
        OPEN_CART,
        CSS_CHECK,
        { type: "click", locator: css("button.add-to-cart") },
        CSS_CHECK,
    ]);
    assert.deepEqual(disabledPaths(errorsOf(parserEnabling(allBut("css-locator")), plan)), [
        "$.steps[1].locator.by",
        "$.steps[2].locator.by",
        "$.steps[3].locator.by",
    ]);
});

test("only the disabled feature is reported when the plan also uses enabled ones", () => {
    const plan = unsafePlan([OPEN_CART, CSS_CHECK, XPATH_CHECK]);
    assert.deepEqual(disabledPaths(errorsOf(parserEnabling(["css-locator"]), plan)), [
        "$.steps[2].locator.by",
    ]);
});

test("the plan using all six parses once the project enables all six", () => {
    acceptedBy(parserEnabling(FEATURES), ALL_FEATURES_PLAN());
});

// ---- Nothing is echoed ------------------------------------------------------------------------------

test("a refusal for a disabled feature echoes no selector, expression, script text or argument", () => {
    const plan = unsafePlan([
        OPEN_CART,
        { type: "click", locator: css(`button.${PRIVATE_MARKER}`) },
        { type: "click", locator: xpath(`//button[contains(text(),"${PRIVATE_MARKER}")]`) },
        {
            type: "evaluate",
            script: { inline: { source: `() => "${PRIVATE_MARKER}"`, effect: "read" } },
            arguments: {},
        },
        { type: "evaluate", script: "seedEditor", arguments: { text: PRIVATE_MARKER } },
    ]);
    const errors = errorsOf(parserEnabling(NOTHING_ENABLED), plan);
    assert.ok(errors.length >= 4, JSON.stringify(errors));
    assert.ok(!JSON.stringify(errors).includes(PRIVATE_MARKER), "a refusal echoed the plan's text");
});

// ---- Nothing runs ----------------------------------------------------------------------------------

test("a plan refused for a disabled feature opens no browser, makes no call and runs no script or command", async () => {
    const project = parsedProject(unsafeProjectFile(NOTHING_ENABLED));
    const parse = parserEnabling(NOTHING_ENABLED);
    const spy = spyDriver();
    const { caller, requests } = routedServiceCaller();
    const ports = fakePorts({ drivers: new Map([["cdp", spy]]), services: caller });
    const base = {
        project,
        baseUrl: baseUrlOf(ORIGIN),
        seed: 42,
        fixedTimeMilliseconds: 0,
        fixtures: [],
        host: { platform: platform(), arch: arch() },
    };
    const plans: readonly JsonRecord[] = [
        ...FEATURE_EXAMPLES.map((example) => unsafePlan(example.steps)),
        ALL_FEATURES_PLAN(),
    ];
    for (const plan of plans) {
        const outcome = await createRunService(ports).runUntrusted(plan, parse, base);
        assert.ok(outcome.kind === UntrustedRunOutcomeKind.Rejected, JSON.stringify(outcome));
        assert.ok(
            outcome.errors.some((error) => error.code === "unsafe_feature_disabled"),
            JSON.stringify(outcome.errors),
        );
    }
    assert.equal(
        spy.calls.count("open"),
        0,
        "a browser was opened, so a script could have run in it",
    );
    assert.equal(requests.length, 0, "a call was made");
});

// ---- Selector and expression text -------------------------------------------------------------------

type LocatorCase = {
    readonly kind: "css" | "xpath";
    readonly field: "selector" | "expression";
    readonly locator: (text: unknown, fields?: JsonRecord) => JsonRecord;
};
const LOCATOR_KINDS: readonly LocatorCase[] = [
    { kind: StructuralLocatorKind.Css, field: "selector", locator: css },
    { kind: StructuralLocatorKind.Xpath, field: "expression", locator: xpath },
];

// A plan that clicks the locator, with a value orderCode defined, so a reference to it is defined.
const clickPlan = (locator: JsonRecord): JsonRecord =>
    unsafePlan([OPEN_CART, { type: "click", locator }], {
        values: { orderCode: { kind: "uniqueText", prefix: "order" } },
    });

const parseAll = parserEnabling(FEATURES);
const BASE_TEXT: Readonly<Record<LocatorCase["kind"], string>> = {
    css: "ul.cart > li.item",
    xpath: "//ul//li[2]",
};

for (const locatorCase of LOCATOR_KINDS) {
    const path = `$.steps[1].locator.${locatorCase.field}`;

    test(`a ${locatorCase.kind} locator whose ${locatorCase.field} is a value reference is refused with wrong_type`, () => {
        assert.deepEqual(
            rejection(parseAll, clickPlan(locatorCase.locator({ valueName: "orderCode" }))),
            [`wrong_type ${path}`],
        );
    });

    test(`a ${locatorCase.kind} ${locatorCase.field} holding a line break is refused with unsafe_text`, () => {
        for (const lineBreak of ["\n", "\r\n", "\r"]) {
            assert.deepEqual(
                rejection(
                    parseAll,
                    clickPlan(locatorCase.locator(`${BASE_TEXT[locatorCase.kind]}${lineBreak}li`)),
                ),
                [`unsafe_text ${path}`],
                JSON.stringify(lineBreak),
            );
        }
    });

    for (const character of ["{", "}", ";", "@"]) {
        test(`a ${locatorCase.kind} ${locatorCase.field} holding "${character}" is refused with unsafe_text, echoing nothing`, () => {
            const errors = errorsOf(
                parseAll,
                clickPlan(
                    locatorCase.locator(
                        `${BASE_TEXT[locatorCase.kind]}${character}${PRIVATE_MARKER}`,
                    ),
                ),
            );
            assert.deepEqual(
                errors.map((error) => `${error.code} ${error.path}`),
                [`unsafe_text ${path}`],
            );
            assert.ok(
                !JSON.stringify(errors).includes(PRIVATE_MARKER),
                "the refusal echoed the text",
            );
        });
    }

    test(`a ${locatorCase.kind} ${locatorCase.field} of 513 characters is refused with too_long, and one of 512 parses`, () => {
        const padded = (length: number): string =>
            `${BASE_TEXT[locatorCase.kind]}${"a".repeat(length - BASE_TEXT[locatorCase.kind].length)}`;
        assert.equal(padded(513).length, 513);
        assert.deepEqual(rejection(parseAll, clickPlan(locatorCase.locator(padded(513)))), [
            `too_long ${path}`,
        ]);
        acceptedBy(parseAll, clickPlan(locatorCase.locator(padded(512))));
    });

    // Counter-example: the same locator with safe literal text parses, so the refusals above come
    // from the text alone.
    test(`a ${locatorCase.kind} locator with safe literal text parses`, () => {
        acceptedBy(parseAll, clickPlan(locatorCase.locator(BASE_TEXT[locatorCase.kind])));
    });

    test(`a ${locatorCase.kind} locator's hasText may hold a value reference, though its ${locatorCase.field} may not`, () => {
        acceptedBy(
            parseAll,
            clickPlan(
                locatorCase.locator(BASE_TEXT[locatorCase.kind], {
                    hasText: { valueName: "orderCode" },
                }),
            ),
        );
    });
}

test('an XPath expression selecting by attribute is refused, since it needs "@"', () => {
    assert.deepEqual(rejection(parseAll, clickPlan(xpath('//button[@type="submit"]'))), [
        "unsafe_text $.steps[1].locator.expression",
    ]);
});

test("a selector error inside an inside locator is reported at its own path", () => {
    const plan = clickPlan(css("button.add", { inside: css("li.product;") }));
    assert.deepEqual(rejection(parseAll, plan), ["unsafe_text $.steps[1].locator.inside.selector"]);
});

// ---- The inside chain ------------------------------------------------------------------------------

// A css locator nested `depth` times through `inside`, alternating css and XPath and ending in a
// role locator, so every kind of locator may stand inside.
function nested(depth: number): JsonRecord {
    let locator: JsonRecord = { by: "role", role: "region", name: "Products" };
    for (let level = depth; level >= 1; level--) {
        locator =
            level % 2 === 0
                ? xpath("//li", { inside: locator })
                : css("li.product", { inside: locator });
    }
    return css("button.add", { inside: locator });
}

test("an inside chain 3 deep parses", () => {
    acceptedBy(parseAll, clickPlan(nested(2)));
});

test("an inside chain 4 deep is refused with too_large at the inside that goes past the limit", () => {
    // nested(3) puts four locators under the clicked one: the fourth `inside` is one too many.
    assert.deepEqual(rejection(parseAll, clickPlan(nested(3))), [
        "too_large $.steps[1].locator.inside.inside.inside.inside",
    ]);
});

test("an inside chain far past the limit gets the same one error, at the same place", () => {
    assert.deepEqual(rejection(parseAll, clickPlan(nested(40))), [
        "too_large $.steps[1].locator.inside.inside.inside.inside",
    ]);
});
