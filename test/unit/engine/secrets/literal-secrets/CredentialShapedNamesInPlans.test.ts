// Text shaped like a credential is refused wherever a plan writes it, because the plan is kept and
// shown. Names and JSON pointers follow patterns of their own, so each one is checked here. Pointers
// are shown to the approver in the readable text too, so the rules on hidden text apply to them, and
// one must never produce text that does not read back.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProject, planHash, readPlanText, writePlanText } from "@revisum/engine";
import { tokenShapedText } from "../../evidence/examples/EvidenceRun.ts";
import { accepted, type JsonRecord } from "../../run/values/examples/RunPlan.ts";
import { errorsOf, parserEnabling } from "../../plan/unsafe-features/examples/LostByFeature.ts";
import {
    FEATURES,
    INLINE_SOURCE,
    OPEN_CART,
    READ_CART,
    unsafePlan,
    unsafeProjectFile,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";
import { unsafeLimits } from "../../plan/readable/examples/UnsafeMark.ts";

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

const REFUSED_POINTERS: readonly {
    readonly name: string;
    readonly pointer: string;
    readonly code: string;
}[] = [
    { name: "a bidirectional override", pointer: "/total‮user", code: "unsafe_text" },
    {
        name: "more characters than any plan text may hold",
        pointer: `/${"a".repeat(limits.maximumTextLength + 1)}`,
        code: "too_long",
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

// Everywhere a plan may be given a key its grammar does not know, with the key as a function of the plan.
const PLANS_WITH_AN_UNKNOWN_KEY: readonly {
    readonly name: string;
    readonly planWithKey: (key: string) => JsonRecord;
}[] = [
    { name: "a plan", planWithKey: (key) => ({ ...planWith(captureStep("ok")), [key]: "x" }) },
    {
        name: "a plan's meta",
        planWithKey: (key) => {
            const plan = planWith(captureStep("ok"));
            return { ...plan, meta: { ...(plan["meta"] as JsonRecord), [key]: "x" } };
        },
    },
    { name: "a step", planWithKey: (key) => planWith({ ...captureStep("ok"), [key]: "x" }) },
    {
        name: "a locator",
        planWithKey: (key) =>
            planWith({ ...downloadStep("ok"), locator: { ...EXPORT_BUTTON, [key]: "x" } }),
    },
    {
        name: "a page script's arguments",
        planWithKey: (key) =>
            planWith({
                ...READ_CART,
                arguments: { ...(READ_CART["arguments"] as JsonRecord), [key]: "x" },
            }),
    },
];

const errorsOfProjectWithKey = (key: string): string => {
    const parsed = parseProject({ ...unsafeProjectFile(), [key]: "x" });
    assert.equal(parsed.ok, false, "the project was accepted");
    return JSON.stringify(parsed);
};

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

    for (const { name, planWithKey } of PLANS_WITH_AN_UNKNOWN_KEY) {
        describe(`given ${name} with an unknown key shaped like a credential`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the plan", () => {
                    assert.ok(errorsOf(parsePlan, planWithKey(MIXED_CASE_TOKEN)).length > 0);
                });

                test("then it should not repeat the key in its errors", () => {
                    assert.ok(
                        !JSON.stringify(
                            errorsOf(parsePlan, planWithKey(MIXED_CASE_TOKEN)),
                        ).includes(MIXED_CASE_TOKEN),
                        "an error repeats the credential",
                    );
                });
            });
        });

        describe(`given ${name} with an unknown key that is ordinary text`, () => {
            describe("when the plan is parsed", () => {
                test("then it should name the key in its errors", () => {
                    assert.ok(
                        JSON.stringify(errorsOf(parsePlan, planWithKey("shippingNote"))).includes(
                            "shippingNote",
                        ),
                    );
                });
            });
        });
    }

    for (const { name, pointer, code } of REFUSED_POINTERS) {
        describe(`given an inline script's field pointer holding ${name}`, () => {
            describe("when the plan is parsed", () => {
                test(`then it should refuse it as ${code}`, () => {
                    assert.deepEqual(
                        errorsOf(parsePlan, planWith(inlineStep(pointer))).map(
                            (error) => error.code,
                        ),
                        [code],
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

describe("Using the project parser", () => {
    describe("given a project with an unknown key shaped like a credential", () => {
        describe("when the project is parsed", () => {
            test("then it should not repeat the key in its errors", () => {
                assert.ok(
                    !errorsOfProjectWithKey(MIXED_CASE_TOKEN).includes(MIXED_CASE_TOKEN),
                    "an error repeats the credential",
                );
            });
        });
    });

    describe("given a project with an unknown key that is ordinary text", () => {
        describe("when the project is parsed", () => {
            test("then it should name the key in its errors", () => {
                assert.ok(errorsOfProjectWithKey("shippingNote").includes("shippingNote"));
            });
        });
    });
});
