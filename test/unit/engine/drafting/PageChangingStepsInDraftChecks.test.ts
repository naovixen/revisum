// Whether a step may change the page is stated by each step type. A draft's locators are checked
// against the page a `Go to` opened until a step may have left it: the line after such a step is no
// longer checked, and the line after any other step still is. A `Go to` opens a page of its own, so
// it isn't a step that may leave one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StepType, TextReading } from "@revisum/engine";
import { STEP_FACTS } from "../../../../packages/engine/src/plan/StepFacts.ts";
import {
    DECLARED_FIXTURE,
    EVERY_STEP_TYPE_EXAMPLES,
    type StepExample,
} from "../plan/examples/EveryStepTypeExamples.ts";
import { checkDraftLocators, type PageMap } from "./examples/CrawlOutcome.ts";
import { acceptedBy, parserEnabling } from "../plan/unsafe-features/examples/LostByFeature.ts";
import { FEATURES, unsafePlan, type JsonRecord } from "../plan/unsafe-features/examples/UnsafePlan.ts";

const parsePlan = parserEnabling(FEATURES, { fixtures: [DECLARED_FIXTURE] });

const CHANGES_PAGE = {
    click: true,
    hover: false,
    fill: false,
    select: true,
    upload: true,
    press: true,
    frame: false,
    dialog: true,
    expect: false,
    expectPage: false,
    a11yAudit: false,
    capture: false,
    remember: false,
    download: true,
    expectDownload: false,
    newTab: false,
    call: false,
    expectBackend: false,
    stub: false,
    resetRequests: false,
    expectRequests: false,
    expectResponse: false,
    setStorage: false,
    removeStorage: false,
    expectStorage: false,
    advanceClock: false,
    expectClipboard: false,
    evaluate: true,
    expectScript: false,
    database: false,
    expectDatabase: false,
} as const satisfies Readonly<Record<Exclude<StepType, "navigate">, boolean>>;

const PAGE_PATH = "/contact";
const MAP: PageMap = {
    origin: "http://127.0.0.1:4173",
    truncated: false,
    guaranteeLevel: "host",
    pages: [{ path: PAGE_PATH, title: "Contact", depth: 1, tree: [] }],
};

const OPEN_MAPPED_PAGE: JsonRecord = { type: "navigate", url: PAGE_PATH };
const CHECK_OF_A_MISSING_BUTTON: JsonRecord = {
    type: "expect",
    locator: { by: "role", role: "button", name: "Nowhere at all" },
    assert: { kind: "visible" },
    criterionId: "cart.button-shown",
};

const CHECKED_LINE = 7;

// Only the line after the step has a position, so a warning about any other step is dropped.
const readingOfLineAt = (stepIndex: number): TextReading => ({
    json: null,
    positions: new Map([[`$.steps[${stepIndex}]`, { line: CHECKED_LINE, column: 1 }]]),
    warnings: [],
});

const warningsAfter = ({ step, before = [] }: StepExample) => {
    const steps = [...before, OPEN_MAPPED_PAGE, step, CHECK_OF_A_MISSING_BUTTON];
    const plan = acceptedBy(parsePlan, unsafePlan(steps));
    return checkDraftLocators(plan, readingOfLineAt(steps.length - 1), MAP);
};

const stepTypesTheTableStates = (): readonly (keyof typeof CHANGES_PAGE)[] =>
    Object.keys(CHANGES_PAGE).filter((type): type is keyof typeof CHANGES_PAGE =>
        Object.hasOwn(CHANGES_PAGE, type),
    );

describe("Using the draft locator check", () => {
    for (const type of stepTypesTheTableStates()) {
        const isPageChanging = CHANGES_PAGE[type];
        const examples: readonly StepExample[] = EVERY_STEP_TYPE_EXAMPLES[type];

        describe(`given a ${type} step`, () => {
            describe("when the step facts are read", () => {
                test(`then it should state that it ${isPageChanging ? "may change" : "keeps"} the page`, () => {
                    assert.equal(STEP_FACTS[type].changesPage, isPageChanging);
                });
            });

            for (const example of examples) {
                describe(`and written ${example.name}`, () => {
                    describe("when the line after it names a button the page doesn't have", () => {
                        test(`then it should ${isPageChanging ? "not check" : "check"} that line`, async () => {
                            assert.deepEqual(
                                await warningsAfter(example),
                                isPageChanging
                                    ? []
                                    : [{ code: "locator-not-on-page", line: CHECKED_LINE }],
                            );
                        });
                    });
                });
            }
        });
    }
});
