// A plan is cleared only for a target both its own targets and the trusted project's matrix
// declare. The policy gate gives any other target a not-declared clearance in place of a cleared
// run, and an untrusted plan's run gives such a target a result ending TargetUnavailable with
// not-declared, before any driver is asked, rather than leaving it with no result at all.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { policyGate } from "@revisum/engine";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import {
    clearanceOn,
    projectWith,
    runUntrustedOn,
    signupPlanOn,
    targetDriver,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "./target-examples.ts";

const DESKTOP = targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280");
const TABLET = targetInput("chromium-tablet", "fake-any", "chromium", "tablet-820");
const SMALL_MATRIX = [DESKTOP];
const LARGE_MATRIX = [DESKTOP, TABLET];
const DESKTOP_ID = targetOf(projectWith(LARGE_MATRIX), "chromium-desktop").id;
const TABLET_ID = targetOf(projectWith(LARGE_MATRIX), "chromium-tablet").id;

describe("Using the policy gate", () => {
    describe("given a target the matrix declares but the plan does not name", () => {
        describe("when the plan is cleared for it", () => {
            test("then it should give a not-declared clearance for that target, not a cleared run", async () => {
                const clearance = clearanceOn({
                    planProject: projectWith(LARGE_MATRIX),
                    trusted: await trustedProjectWith(LARGE_MATRIX),
                    planTargets: ["chromium-desktop"],
                    targetId: TABLET_ID,
                });
                assert.equal(clearance.kind, "not-declared");
                assert.equal(clearance.targetId, TABLET_ID);
            });
        });

        describe("when the plan is decided for that target beside one it names", () => {
            test("then it should clear the named target and give the other a not-declared clearance, in order", async () => {
                const trusted = await trustedProjectWith(LARGE_MATRIX);
                const plan = signupPlanOn(projectWith(LARGE_MATRIX), ["chromium-desktop"]);
                const decision = policyGate({ project: trusted, events: fakeEventSink() }).decide(
                    plan,
                    [DESKTOP_ID, TABLET_ID],
                );
                assert.equal(decision.kind, "allow");
                assert.deepEqual(
                    decision.runs.map((clearance) => [clearance.kind, clearance.targetId]),
                    [
                        ["cleared", DESKTOP_ID],
                        ["not-declared", TABLET_ID],
                    ],
                );
            });
        });
    });

    describe("given a target the plan names but the trusted project's matrix does not declare", () => {
        describe("when the plan is cleared for it", () => {
            test("then it should give a not-declared clearance for that target, not a cleared run", async () => {
                const clearance = clearanceOn({
                    planProject: projectWith(LARGE_MATRIX),
                    trusted: await trustedProjectWith(SMALL_MATRIX),
                    planTargets: ["chromium-desktop", "chromium-tablet"],
                    targetId: TABLET_ID,
                });
                assert.equal(clearance.kind, "not-declared");
            });
        });
    });
});

describe("Using the untrusted run", () => {
    describe("given a plan naming a target the trusted project's matrix does not declare", () => {
        describe("when it is run", () => {
            test("then it should give that target a run ending TargetUnavailable with not-declared, beside the declared target's", async () => {
                const driver = targetDriver("fake-any");
                const ran = await runUntrustedOn({
                    planProject: projectWith(LARGE_MATRIX),
                    trusted: await trustedProjectWith(SMALL_MATRIX),
                    planTargets: ["chromium-desktop", "chromium-tablet"],
                    drivers: new Map([["fake-any", driver]]),
                });
                assert.deepEqual(
                    ran.results.map((result) => [
                        result.targetId,
                        result.state,
                        result.unavailable?.reason,
                    ]),
                    [
                        ["chromium-desktop", "TargetUnavailable", "launch-failed"],
                        ["chromium-tablet", "TargetUnavailable", "not-declared"],
                    ],
                );
                assert.equal(driver.calls.count("open"), 1);
            });
        });

        describe("and the plan names only that target", () => {
            describe("when it is run", () => {
                test("then it should end TargetUnavailable with not-declared, asking no driver anything", async () => {
                    const driver = targetDriver("fake-any");
                    const ran = await runUntrustedOn({
                        planProject: projectWith(LARGE_MATRIX),
                        trusted: await trustedProjectWith(SMALL_MATRIX),
                        planTargets: ["chromium-tablet"],
                        drivers: new Map([["fake-any", driver]]),
                    });
                    assert.deepEqual(
                        ran.results.map((result) => [
                            result.targetId,
                            result.state,
                            result.unavailable?.reason,
                        ]),
                        [["chromium-tablet", "TargetUnavailable", "not-declared"]],
                    );
                    assert.equal(driver.calls.count(), 0);
                });
            });
        });
    });
});
