// A name must not slip past the gate by how it is accented: a French page may write its capitals
// without the accent, a dotted capital I is still an i, and an English word stays that word with an
// accent added. Other words that only look close stay allowed, or the gate would stop ordinary pages.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
    ALLOWED,
    ENGLISH,
    FRENCH,
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
    withPatterns,
    type TestGate,
} from "../examples/Policy.ts";

const CAPITAL_I_WITH_DOT = "İ";
const COMBINING_ACUTE_ACCENT = "́";

type LocalisedName = {
    readonly language: string;
    readonly targetId: string;
    readonly name: string;
};

const IRREVERSIBLE_NAMES: readonly LocalisedName[] = [
    { language: "French", targetId: FRENCH, name: "REVOQUER" },
    { language: "French", targetId: FRENCH, name: "Revoquer" },
    { language: "French", targetId: FRENCH, name: `SUPPR${CAPITAL_I_WITH_DOT}MER` },
    { language: "English", targetId: ENGLISH, name: "Délete account" },
    { language: "English", targetId: ENGLISH, name: `De${COMBINING_ACUTE_ACCENT}lete account` },
    // Combining marks live in several Unicode blocks, and a browser draws each the same way.
    { language: "English", targetId: ENGLISH, name: "de᷄lete account" },
    { language: "English", targetId: ENGLISH, name: "d⃐elete" },
    { language: "English", targetId: ENGLISH, name: "de︠lete" },
];

// In these scripts a vowel sign is a letter of the word, so dropping one reads a different word.
const WORD_WITH_NO_VOWEL_SIGN = "कल";
const SAME_WORD_WITH_A_VOWEL_SIGN = "कुल";
const OTHER_WORD_WITH_A_VOWEL_SIGN = "ลิบ";
const OTHER_WORD_WITH_NO_VOWEL_SIGN = "ลบ";
const VOWEL_SIGN_PROJECT = withPatterns({
    "en-GB": [WORD_WITH_NO_VOWEL_SIGN, OTHER_WORD_WITH_A_VOWEL_SIGN],
});

const ORDINARY_NAMES: readonly LocalisedName[] = [
    { language: "French", targetId: FRENCH, name: "Supprimés" },
    { language: "French", targetId: FRENCH, name: "Révoqué" },
    { language: "English", targetId: ENGLISH, name: "Détails" },
];

let tested: TestGate;
let testedOnVowelSigns: TestGate;
before(async () => {
    tested = await testGate();
    testedOnVowelSigns = await testGate(VOWEL_SIGN_PROJECT);
});

const decisionOnClickingUnderVowelSignPatterns = (name: string) =>
    comparable(
        decideOn(
            testedOnVowelSigns,
            parsedPlan(
                planOf([OPEN_ACCOUNT_PAGE, click(role("button", name))]),
                VOWEL_SIGN_PROJECT,
            ),
        ),
    );

const decisionOnPlanClicking = ({ targetId, name }: LocalisedName) =>
    comparable(
        decideOn(
            tested,
            parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(role("button", name))], [targetId])),
        ),
    );

// What the runtime guard says of a control the plan found by test id, whose name only the page shows.
const verdictOnControlNamed = ({ targetId, name }: LocalisedName) => {
    const plan = parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(testId("row-action"))], [targetId]));
    return tested.gate.guardAction(
        stepAt(plan, 1),
        1,
        element({ role: "button", name }),
        null,
        localeOf(tested.project, targetId),
    );
};

describe("Using the policy gate", () => {
    for (const irreversible of IRREVERSIBLE_NAMES) {
        describe(`given a plan for a ${irreversible.language} target that clicks ${irreversible.name}`, () => {
            describe("when the plan is decided", () => {
                test("then it should deny it as irreversible", () => {
                    assert.deepEqual(
                        decisionOnPlanClicking(irreversible),
                        denied("irreversible-action", 1),
                    );
                });
            });
        });

        describe(`given a control on a ${irreversible.language} page named ${irreversible.name}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny the click", () => {
                    assert.deepEqual(verdictOnControlNamed(irreversible), {
                        kind: "deny",
                        rule: "irreversible-action",
                        stepIndex: 1,
                    });
                });
            });
        });
    }

    for (const name of [WORD_WITH_NO_VOWEL_SIGN, OTHER_WORD_WITH_A_VOWEL_SIGN]) {
        describe(`given a project whose patterns name ${name}`, () => {
            describe("and a plan that clicks that word", () => {
                describe("when the plan is decided", () => {
                    test("then it should deny it as irreversible", () => {
                        assert.deepEqual(
                            decisionOnClickingUnderVowelSignPatterns(name),
                            denied("irreversible-action", 1),
                        );
                    });
                });
            });
        });
    }

    for (const { name, pattern } of [
        { name: SAME_WORD_WITH_A_VOWEL_SIGN, pattern: WORD_WITH_NO_VOWEL_SIGN },
        { name: OTHER_WORD_WITH_NO_VOWEL_SIGN, pattern: OTHER_WORD_WITH_A_VOWEL_SIGN },
    ]) {
        describe(`given a project whose patterns name ${pattern}`, () => {
            describe(`and a plan that clicks ${name}, which differs by one vowel sign`, () => {
                describe("when the plan is decided", () => {
                    test("then it should allow it", () => {
                        assert.deepEqual(decisionOnClickingUnderVowelSignPatterns(name), ALLOWED);
                    });
                });
            });
        });
    }

    for (const ordinary of ORDINARY_NAMES) {
        describe(`given a plan for a ${ordinary.language} target that clicks the ordinary name ${ordinary.name}`, () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", () => {
                    assert.deepEqual(decisionOnPlanClicking(ordinary), ALLOWED);
                });
            });
        });

        describe(`given a control on a ${ordinary.language} page with the ordinary name ${ordinary.name}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should allow the click", () => {
                    assert.deepEqual(verdictOnControlNamed(ordinary), { kind: "allow" });
                });
            });
        });
    }
});
