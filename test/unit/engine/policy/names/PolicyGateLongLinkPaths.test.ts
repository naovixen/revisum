// A hostile page chooses the links the runtime guard reads, so a page can hand the guard the path it
// finds hardest. Time spent must stay in step with the length of that path, and what trails a path in
// white space and slashes must still count for nothing.
//
// The timing tests compare the same work at two lengths rather than against a clock, so a slow machine
// slows both alike. Four times the path takes about four times as long when the work is linear and
// about sixteen times when it is quadratic.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
    ENGLISH,
    OPEN_ACCOUNT_PAGE,
    ORIGIN,
    click,
    element,
    localeOf,
    parsedPlan,
    planOf,
    role,
    stepAt,
    testGate,
    type TestGate,
} from "../examples/Policy.ts";

const LENGTH_FACTOR = 4;
const MOST_GROWTH_ALLOWED = 8;

// Work this quick is lost in timer resolution and garbage collection, where a ratio means nothing.
const MILLISECONDS_OF_NOISE = 25;

const ROUNDS = 3;
const RUN_LENGTH = 4_000;

const RUNS: readonly { readonly name: string; readonly unit: string }[] = [
    { name: "URL-encoded spaces", unit: "%20" },
    { name: "URL-encoded spaces between slashes", unit: "%20/" },
];

let tested: TestGate;
before(async () => {
    tested = await testGate();
});

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

const millisecondsToGuard = (path: string): number => {
    const started = performance.now();
    verdictOnLinkTo(path);
    return performance.now() - started;
};

// The quickest of several rounds, alternating the lengths, so that a pause or a burst of other work
// on the machine lands on neither length alone.
function assertGuardTimeGrowsInStepWithLength(pathOfLength: (length: number) => string): void {
    let shorter = Number.POSITIVE_INFINITY;
    let longer = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round += 1) {
        shorter = Math.min(shorter, millisecondsToGuard(pathOfLength(RUN_LENGTH)));
        longer = Math.min(longer, millisecondsToGuard(pathOfLength(RUN_LENGTH * LENGTH_FACTOR)));
    }
    assert.ok(
        longer <= shorter * MOST_GROWTH_ALLOWED + MILLISECONDS_OF_NOISE,
        `${LENGTH_FACTOR} times the path took ${(longer / shorter).toFixed(1)} times as long: ${shorter.toFixed(1)} ms, then ${longer.toFixed(1)} ms`,
    );
}

describe("Using the policy gate", () => {
    for (const { name, unit } of RUNS) {
        describe(`given a link whose path is a long run of ${name} that a letter ends`, () => {
            describe("when the runtime guard reads a path four times as long", () => {
                test("then it should take about four times as long", () => {
                    assertGuardTimeGrowsInStepWithLength((length) => `/${unit.repeat(length)}x`);
                });
            });
        });

        describe(`given a link to a destructive path followed by a long run of ${name}`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should deny the click", () => {
                    assert.equal(
                        verdictOnLinkTo(`/account/delete${unit.repeat(RUN_LENGTH)}`),
                        "deny",
                    );
                });
            });
        });

        describe(`given a link to a destructive path, a long run of ${name} and a letter`, () => {
            describe("when the runtime guard is asked", () => {
                test("then it should allow the click, since the run does not trail", () => {
                    assert.equal(
                        verdictOnLinkTo(`/account/delete${"%20".repeat(RUN_LENGTH)}x`),
                        "allow",
                    );
                });
            });
        });
    }
});
