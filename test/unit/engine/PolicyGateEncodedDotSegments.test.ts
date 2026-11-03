// A server may decode a path more than once, and only then read its "." and ".." segments. So the
// gate has to judge the path it would reach once every layer is decoded and those segments are
// resolved, or a double-encoded ".." walks a plan to a destructive route the gate reads as another.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
    ALLOWED,
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
    type TestGate,
} from "./policy-examples.ts";

const REACHES_THE_DESTRUCTIVE_ROUTE: readonly string[] = [
    "/account/%252e%252e/account/delete",
    "/account/%252E%252E/account/delete",
    "/shop/%252e%252e/account/delete",
    "/account/settings/%252e%252e/delete",
    "/account/%252e/delete",
    "/account/%25252e%25252e/account/delete",
    "/account/%2e%252e/account/delete",
    "/shop/..%252faccount/delete",
    "/shop/%252e%252e%252faccount/delete",
    "/shop/%252e%252e%252faccount%252fdelete",
    "/shop/%252e%252e;x=1/account/delete",
    "/account/delete/%252e%252e/settings",
    "/account/delete//%252e%252e/settings",
    "/account//delete",
    "/account/%2f/delete",
    "/account/%252e%252e//account/delete",
    // Where "//" holds an empty segment, ".." climbs out of that alone.
    "/account//%252e%252e/delete",
    "/account/settings//%252e%252e/%252e%252e/delete",
    // Where "//" is merged into one slash, ".." climbs out of the segment before it.
    "/account/settings//%252e%252e/delete",
    // On both readings.
    "/shop//%252e%252e/%252e%252e/account/delete",
];

const REACHES_ANOTHER_ROUTE: readonly string[] = [
    "/account/%252e%252e/account/settings",
    "/shop/%252e%252e/account/settings",
    "/account/%252e%252ehidden/delete",
    "/shop/%252e%252e;x=1/account/settings",
    "/account//settings",
    "/account//%252e%252e/settings",
    "/account/settings//%252e%252e/settings",
    "/account//%252e%252edelete",
    "/account/deleted",
    "/account/deleted//%252e%252e/deleted",
];

let tested: TestGate;
before(async () => {
    tested = await testGate();
});

const decisionOnNavigationTo = (path: string) =>
    comparable(decideOn(tested, parsedPlan(planOf([navigate(path)]))));

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

describe("Using the policy gate", () => {
    for (const path of REACHES_THE_DESTRUCTIVE_ROUTE) {
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

    for (const path of REACHES_ANOTHER_ROUTE) {
        describe(`given a plan that navigates to ${path}, which ends on another route`, () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", () => {
                    assert.deepEqual(decisionOnNavigationTo(path), ALLOWED);
                });
            });
        });

        describe(`given a click on a link to ${path}, which ends on another route`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should allow the click", () => {
                    assert.equal(verdictOnLinkTo(path), "allow");
                });
            });
        });
    }
});
