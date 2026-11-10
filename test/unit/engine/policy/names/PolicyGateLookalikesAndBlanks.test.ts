// No table can list every letter that passes for another, so the gate reads a name in the ways it
// practically can. It treats the Latin letters and digits people swap for one another as the same, it
// drops every character that draws nothing, and it fails closed on a word that mixes Latin with a
// letter of an alphabet it can't read. Names in one script, and Latin beside scripts that are written
// together with it, stay allowed, or the gate would stop ordinary pages.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
    ALLOWED,
    ENGLISH,
    OPEN_ACCOUNT_PAGE,
    click,
    comparable,
    decideOn,
    denied,
    element,
    localeOf,
    parsedPlan,
    planOf,
    role,
    stepAt,
    testGate,
    testId,
    type TestGate,
} from "../examples/Policy.ts";

const HANGUL_FILLER = "ㅤ";
const HANGUL_CHOSEONG_FILLER = "ᅟ";
const HANGUL_JUNGSEONG_FILLER = "ᅠ";
const HALFWIDTH_HANGUL_FILLER = "ﾠ";
const BRAILLE_BLANK = "⠀";
const COMBINING_GRAPHEME_JOINER = "͏";
const VARIATION_SELECTOR = "️";
const KHMER_INHERENT_VOWEL = "឴";
const MONGOLIAN_VARIATION_SELECTOR = "᠋";

const LISU_LETTER_D = "ꓓ";
const CHEROKEE_LETTER_S = "Ꮪ";
const CYRILLIC_E = "е";

const CONFUSED_NAMES: readonly { readonly written: string; readonly name: string }[] = [
    { written: "with a capital I for an l", name: "deIete" },
    { written: "with a capital I for an l, then another word", name: "DeIete account" },
    { written: "with a digit 1 for an l", name: "de1ete" },
    { written: "in capitals with a digit 1 for an L", name: "DE1ETE" },
    { written: "with a digit 0 for an o", name: "Rev0ke access" },
    { written: "with a digit 5 for an s", name: "5end invoice" },
];

const MIXED_SCRIPT_NAMES: readonly { readonly written: string; readonly name: string }[] = [
    { written: "with a Lisu letter the gate can't read", name: `${LISU_LETTER_D}elete` },
    { written: "with a Cherokee letter the gate can't read", name: `${CHEROKEE_LETTER_S}end` },
];

const FILLERS: readonly { readonly written: string; readonly filler: string }[] = [
    { written: "Hangul filler", filler: HANGUL_FILLER },
    { written: "a Hangul choseong filler", filler: HANGUL_CHOSEONG_FILLER },
    { written: "a Hangul jungseong filler", filler: HANGUL_JUNGSEONG_FILLER },
    { written: "a halfwidth Hangul filler", filler: HALFWIDTH_HANGUL_FILLER },
    { written: "a Braille blank", filler: BRAILLE_BLANK },
    { written: "a combining grapheme joiner", filler: COMBINING_GRAPHEME_JOINER },
    { written: "a variation selector", filler: VARIATION_SELECTOR },
    { written: "a Khmer inherent vowel", filler: KHMER_INHERENT_VOWEL },
    { written: "a Mongolian variation selector", filler: MONGOLIAN_VARIATION_SELECTOR },
];

const ORDINARY_NAMES: readonly string[] = [
    "USB연결",
    "Item 1",
    "Page 11",
    "Top10",
    "Windows 11",
    "Step 5",
    "Mail",
    "Idle",
    "ID",
    "Save",
    `Pr${CYRILLIC_E}view`,
    "Настройки",
    "Settings Настройки",
    "設定",
    "PDFを開く",
    "Wi-Fi設定",
    "Café",
    "설정",
    "⚙️",
];

let tested: TestGate;
before(async () => {
    tested = await testGate();
});

const decisionOnPlanClicking = (name: string) =>
    comparable(
        decideOn(tested, parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(role("button", name))]))),
    );

// What the runtime guard says of a control the plan found by test id, whose name only the page shows.
const verdictOnControlNamed = (name: string) => {
    const plan = parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(testId("row-action"))]));
    return tested.gate.guardAction(
        stepAt(plan, 1),
        1,
        element({ role: "button", name }),
        null,
        localeOf(tested.project, ENGLISH),
    );
};

const IRREVERSIBLE = { kind: "deny", rule: "irreversible-action", stepIndex: 1 };
const UNNAMED = { kind: "deny", rule: "unnamed-control", stepIndex: 1 };

describe("Using the policy gate", () => {
    for (const { written, name } of [...CONFUSED_NAMES, ...MIXED_SCRIPT_NAMES]) {
        describe(`given a plan that clicks an irreversible name written ${written}`, () => {
            describe("when the plan is decided", () => {
                test("then it should deny it as irreversible", () => {
                    assert.deepEqual(
                        decisionOnPlanClicking(name),
                        denied("irreversible-action", 1),
                    );
                });
            });
        });

        describe(`given a control on the page with an irreversible name written ${written}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny the click", () => {
                    assert.deepEqual(verdictOnControlNamed(name), IRREVERSIBLE);
                });
            });
        });
    }

    for (const { written, filler } of FILLERS) {
        describe(`given a control whose whole name is ${written}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny it as unnamed", () => {
                    assert.deepEqual(verdictOnControlNamed(filler), UNNAMED);
                });
            });
        });

        describe(`given a control named Delete with ${written} inside the word`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny it as irreversible", () => {
                    assert.deepEqual(verdictOnControlNamed(`De${filler}lete`), IRREVERSIBLE);
                });
            });
        });
    }

    for (const name of ORDINARY_NAMES) {
        describe(`given a control on the page with the ordinary name ${name}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should allow the click", () => {
                    assert.deepEqual(verdictOnControlNamed(name), ALLOWED);
                });
            });
        });
    }
});
