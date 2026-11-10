// The own CDP driver performs a remember step, a positioned locator and a key chord, and the fixture
// page (test/fixtures/sites/plan-values-app/remember.html) counts the input they send. The same plans run with the
// plainer form of each step.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    label,
    navigate,
    press,
    remember,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { planValuesHarness } from "./support/PlanValuesHarness.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";

shareBrowserInThisFile();

let harness: BrowserHarness;
before(async () => {
    harness = await planValuesHarness();
});
after(async () => {
    await harness.close();
});

type Feature = {
    readonly name: string;
    readonly withFeature: JsonRecord;
    readonly without: JsonRecord;
};

const FEATURES: readonly Feature[] = [
    {
        name: "a remember step",
        withFeature: remember("orderNumber", testId("order-number")),
        without: textEquals(testId("order-number"), "ORD-58213", "refusals.order-number-shown"),
    },
    {
        name: "a positioned locator",
        withFeature: click(role("button", "Save", { position: 1 })),
        without: click(role("button", "Save")),
    },
    {
        name: "a key chord",
        withFeature: press(label("Search"), "k", ["Shift"]),
        without: press(label("Search"), "k"),
    },
];

// Open the page, use the feature, then send input and check the page.
const stepsWith = (step: JsonRecord) => [
    navigate("/remember.html"),
    step,
    click(role("button", "Save")),
    textEquals(testId("order-number"), "ORD-58213", "refusals.page-shown"),
];

describe(`the own CDP driver: ${BrowserTarget.Chrome}`, () => {
    for (const feature of FEATURES) {
        test(`counter-example: a run without ${feature.name} passes and sends its input`, async () => {
            const { result, atClose } = await harness.runSteps(
                BrowserTarget.Chrome,
                stepsWith(feature.without),
            );
            assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            assert.notEqual(atClose?.shown["input-events"], "0");
        });
    }

    for (const feature of FEATURES) {
        test(`a run with ${feature.name} performs it and passes`, async () => {
            const { result, atClose } = await harness.runSteps(
                BrowserTarget.Chrome,
                stepsWith(feature.withFeature),
            );
            assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            assert.notEqual(atClose?.shown["input-events"], "0");
        });
    }
});
