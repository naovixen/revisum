// A name that a person reads as Delete must read as Delete to the gate, however the page writes it: run
// into the next word in capitals, or with letters of another script that look the same. Words that
// only start the same way stay allowed, or the gate would stop ordinary pages.
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

const CYRILLIC_A = "а";
const CYRILLIC_CAPITAL_E = "Е";
const CYRILLIC_E = "е";
const CYRILLIC_O = "о";
const CYRILLIC_DZE = "ѕ";
const GREEK_EPSILON = "ε";
const GREEK_CAPITAL_EPSILON = "Ε";
const GREEK_OMICRON = "ο";
const GREEK_RHO = "ρ";

const IRREVERSIBLE_NAMES: readonly { readonly written: string; readonly name: string }[] = [
    { written: "in capitals run into the next word", name: "DELETEaccount" },
    { written: "in capitals run into the next word, paying", name: "PAYnow" },
    { written: "in capitals run into the next word, sending", name: "SENDinvoice" },
    { written: "in capitals run into the next word, revoking", name: "REVOKEaccess" },
    { written: "after a word in capitals", name: "ACCOUNTdelete" },
    { written: "with a Cyrillic e", name: `D${CYRILLIC_E}lete account` },
    { written: "with every e Cyrillic", name: `D${CYRILLIC_E}l${CYRILLIC_E}t${CYRILLIC_E}` },
    { written: "with a Greek epsilon", name: `Del${GREEK_EPSILON}te` },
    {
        written: "in capitals with Cyrillic and Greek letters",
        name: `D${CYRILLIC_CAPITAL_E}L${GREEK_CAPITAL_EPSILON}TE`,
    },
    { written: "with a Cyrillic a", name: `P${CYRILLIC_A}y now` },
    { written: "with a Greek rho", name: `${GREEK_RHO}ay now` },
    { written: "with a Cyrillic s", name: `${CYRILLIC_DZE}end invoice` },
    { written: "with a Cyrillic o", name: `Rev${CYRILLIC_O}ke access` },
    { written: "with a Greek omicron", name: `Rev${GREEK_OMICRON}ke access` },
    {
        written: "in capitals with a lookalike, run into the next word",
        name: `D${CYRILLIC_CAPITAL_E}LETEaccount`,
    },
];

const ORDINARY_NAMES: readonly string[] = [
    "Deleted items",
    "PAYMENTdetails",
    "Payment details",
    "Sender",
    "SENDERname",
    "Revoked keys",
    "Undelete",
    "APIKeys",
    "Save",
    `Pr${CYRILLIC_E}view`,
    `Привет`,
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

describe("Using the policy gate", () => {
    for (const { written, name } of IRREVERSIBLE_NAMES) {
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
                    assert.deepEqual(verdictOnControlNamed(name), {
                        kind: "deny",
                        rule: "irreversible-action",
                        stepIndex: 1,
                    });
                });
            });
        });
    }

    for (const name of ORDINARY_NAMES) {
        describe(`given a plan that clicks the ordinary name ${name}`, () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", () => {
                    assert.deepEqual(decisionOnPlanClicking(name), ALLOWED);
                });
            });
        });

        describe(`given a control on the page with the ordinary name ${name}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should allow the click", () => {
                    assert.deepEqual(verdictOnControlNamed(name), { kind: "allow" });
                });
            });
        });
    }
});
