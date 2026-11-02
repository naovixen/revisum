// The gate reads a path as a server may: one malformed escape must not stop the rest being decoded,
// and path parameters after a semicolon do not change which route it is. A name made only of
// invisible format characters is no name at all.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
    ALLOWED,
    ALLOWED_UNNAMED_TEST_ID,
    ENGLISH,
    OPEN_ACCOUNT_PAGE,
    ORIGIN,
    click,
    comparable,
    decideOn,
    denied,
    element,
    localeOf,
    navigate,
    parsedPlan,
    planOf,
    role,
    stepAt,
    testGate,
    testId,
    type TestGate,
} from "./policy-examples.ts";

const DESTRUCTIVE_SPELLINGS: readonly string[] = [
    "/account/%64elete/%ZZ",
    "/account/delete/%ZZ",
    "/account/delete;x=1",
    "/ACCOUNT/DELETE;x=1",
    "/account/delete;x=1/confirm",
];

const ORDINARY_PATHS: readonly string[] = [
    "/account/settings/%ZZ",
    "/account/settings;x=1",
    "/account/deleted",
    "/account/delete-history",
];

const ALREADY_READ_AS_DESTRUCTIVE: readonly string[] = [
    "/account/delete",
    "/account/%64elete",
    "/Account//delete/",
];

let tested: TestGate;
before(async () => {
    tested = await testGate();
});

const decisionOnNavigationTo = (path: string) =>
    comparable(decideOn(tested, parsedPlan(planOf([navigate(path)]))));

// What the runtime guard says about a link to `path` on the account page.
const verdictOnLinkTo = (path: string): string => {
    const plan = parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(role("link", "Open"))]));
    return tested.gate.guardAction(
        stepAt(plan, 1),
        1,
        element({ role: "link", name: "Open", linkUrl: `${ORIGIN}${path}` }),
        null,
        localeOf(tested.project, ENGLISH),
    ).kind;
};

const verdictOnClickNamed = (name: string, id: string): string => {
    const plan = parsedPlan(planOf([OPEN_ACCOUNT_PAGE, click(testId(id))]));
    return JSON.stringify(
        tested.gate.guardAction(
            stepAt(plan, 1),
            1,
            element({ role: "button", name }),
            null,
            localeOf(tested.project, ENGLISH),
        ),
    );
};

describe("Using the policy gate", () => {
    for (const path of DESTRUCTIVE_SPELLINGS) {
        describe(`given a plan that navigates to ${path}`, () => {
            describe("when the plan is decided", () => {
                test("then it should deny the destructive navigation", () => {
                    assert.deepEqual(
                        decisionOnNavigationTo(path),
                        denied("destructive-navigation", 0),
                    );
                });
            });
        });

        describe(`given a click on a link to ${path}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny the click", () => {
                    assert.equal(verdictOnLinkTo(path), "deny");
                });
            });
        });
    }

    for (const path of ALREADY_READ_AS_DESTRUCTIVE) {
        describe(`given a plan that navigates to ${path}, already read as destructive`, () => {
            describe("when the plan is decided", () => {
                test("then it should deny the destructive navigation", () => {
                    assert.deepEqual(
                        decisionOnNavigationTo(path),
                        denied("destructive-navigation", 0),
                    );
                });
            });
        });
    }

    for (const path of ORDINARY_PATHS) {
        describe(`given a plan that navigates to ${path}, which is another route`, () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", () => {
                    assert.deepEqual(decisionOnNavigationTo(path), ALLOWED);
                });
            });
        });
    }

    for (const { title, name } of [
        { title: "only U+200B", name: "​" },
        { title: "U+200B around a space", name: "​ ​" },
        { title: "only a soft hyphen", name: "­" },
    ]) {
        describe(`given a control whose name holds ${title}`, () => {
            describe("when the runtime guard is asked about a click on it", () => {
                test("then it should deny it as unnamed-control", () => {
                    const verdict: unknown = JSON.parse(verdictOnClickNamed(name, "row-action"));
                    assert.deepEqual(verdict, {
                        kind: "deny",
                        rule: "unnamed-control",
                        stepIndex: 1,
                    });
                });
            });
        });
    }

    describe("given a control whose name holds U+200B", () => {
        describe("and the project allows that control by its test id", () => {
            describe("when the runtime guard is asked about a click on it", () => {
                test("then it should allow it", () => {
                    assert.equal(
                        verdictOnClickNamed("​", ALLOWED_UNNAMED_TEST_ID),
                        JSON.stringify(ALLOWED),
                    );
                });
            });
        });
    });

    describe("given a control whose name holds a word beside U+200B", () => {
        describe("when the runtime guard is asked about a click on it", () => {
            test("then it should allow it", () => {
                assert.equal(verdictOnClickNamed("Save​", "row-action"), JSON.stringify(ALLOWED));
            });
        });
    });
});
