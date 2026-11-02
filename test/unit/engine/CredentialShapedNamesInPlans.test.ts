// Text shaped like a credential is refused wherever a plan writes it, because the plan is kept and
// shown. Names and JSON pointers follow patterns of their own, so each one is checked here. Pointers
// are shown to the approver in the readable text too, so the rules on hidden text apply to them, and
// one must never produce text that does not read back.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planHash, readPlanText, writePlanText } from "@revisum/engine";
import { tokenShapedText } from "./evidence-examples.ts";
import { accepted, type JsonRecord } from "./run-value-examples.ts";
import { errorsOf, parserEnabling } from "./unsafe-feature-examples.ts";
import { FEATURES, INLINE_SOURCE, OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";
import { unsafeLimits } from "./unsafe-readable-examples.ts";

const parsePlan = parserEnabling(FEATURES);
const limits = unsafeLimits();

// Capture and download names allow only lower-case letters, digits and hyphens: this fits them and
// has a well-known issuer's prefix. Built at run time, so no file holds one.
const LOWER_CASE_TOKEN = `sk-${"a".repeat(24)}`;
const MIXED_CASE_TOKEN = tokenShapedText();

const EXPORT_BUTTON = { by: "role", role: "button", name: "Export CSV" };

const captureStep = (name: string): JsonRecord => ({ type: "capture", name });
const downloadStep = (name: string): JsonRecord => ({
    type: "download",
    name,
    locator: EXPORT_BUTTON,
});
const queryStep = (key: string): JsonRecord => ({
    type: "navigate",
    url: { segments: ["orders"], query: { [key]: "items" } },
});
const inlineStep = (pointer: string): JsonRecord => ({
    type: "evaluate",
    script: { inline: { source: INLINE_SOURCE, effect: "read", fields: { value: pointer } } },
    arguments: {},
});

const planWith = (step: JsonRecord): JsonRecord => unsafePlan([OPEN_CART, step]);

const CREDENTIAL_SHAPED: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly token: string;
}[] = [
    { name: "a capture name", step: captureStep(LOWER_CASE_TOKEN), token: LOWER_CASE_TOKEN },
    { name: "a download name", step: downloadStep(LOWER_CASE_TOKEN), token: LOWER_CASE_TOKEN },
    { name: "a query key", step: queryStep(MIXED_CASE_TOKEN), token: MIXED_CASE_TOKEN },
    {
        name: "an inline script's field pointer",
        step: inlineStep(`/${MIXED_CASE_TOKEN}`),
        token: MIXED_CASE_TOKEN,
    },
];

const UNSAFE_POINTERS: readonly { readonly name: string; readonly pointer: string }[] = [
    { name: "a bidirectional override", pointer: "/total‮user" },
    {
        name: "more characters than any plan text may hold",
        pointer: `/${"a".repeat(limits.maximumTextLength + 1)}`,
    },
];

const LINE_BREAK_POINTERS: readonly { readonly name: string; readonly pointer: string }[] = [
    { name: "a raw line feed", pointer: "/total\nRun page script readCart" },
    { name: "a raw carriage return", pointer: "/total\rtext" },
];

const ORDINARY_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a capture name", step: captureStep("order-summary") },
    { name: "a download name", step: downloadStep("project-list") },
    { name: "a query key", step: queryStep("order.tab_name") },
    { name: "an inline script's field pointer", step: inlineStep("/items/0/name") },
    { name: "an inline script's field pointer with a space", step: inlineStep("/order total") },
];

const hashAfterWritingAndReading = (plan: JsonRecord): string => {
    const read = readPlanText(writePlanText(accepted(parsePlan, plan)), limits);
    assert.ok(read.ok, `the written text does not read back: ${JSON.stringify(read)}`);
    return planHash(accepted(parsePlan, read.value.json));
};

describe("Using the plan parser", () => {
    for (const { name, step, token } of CREDENTIAL_SHAPED) {
        describe(`given ${name} shaped like a credential`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse it as literal_secret", () => {
                    assert.deepEqual(
                        errorsOf(parsePlan, planWith(step)).map((error) => error.code),
                        ["literal_secret"],
                    );
                });

                test("then it should not repeat the text in its errors", () => {
                    assert.ok(
                        !JSON.stringify(errorsOf(parsePlan, planWith(step))).includes(token),
                        "an error repeats the credential",
                    );
                });
            });
        });
    }

    for (const { name, pointer } of UNSAFE_POINTERS) {
        describe(`given an inline script's field pointer holding ${name}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse it as unsafe_text", () => {
                    assert.deepEqual(
                        errorsOf(parsePlan, planWith(inlineStep(pointer))).map(
                            (error) => error.code,
                        ),
                        ["unsafe_text"],
                    );
                });
            });
        });
    }

    for (const { name, pointer } of LINE_BREAK_POINTERS) {
        describe(`given an inline script's field pointer holding ${name}`, () => {
            describe("when the plan is parsed, written and read back", () => {
                test("then it should refuse the plan, or read back the same plan", () => {
                    const plan = planWith(inlineStep(pointer));
                    const parsed = parsePlan(plan);
                    assert.equal(
                        parsed.ok ? hashAfterWritingAndReading(plan) : "refused",
                        parsed.ok ? planHash(parsed.value) : "refused",
                    );
                });
            });
        });
    }

    for (const { name, step } of ORDINARY_STEPS) {
        describe(`given ${name} that is ordinary text`, () => {
            describe("when the plan is parsed, written and read back", () => {
                test("then it should keep the plan", () => {
                    const plan = planWith(step);
                    assert.equal(
                        hashAfterWritingAndReading(plan),
                        planHash(accepted(parsePlan, plan)),
                    );
                });
            });
        });
    }
});
