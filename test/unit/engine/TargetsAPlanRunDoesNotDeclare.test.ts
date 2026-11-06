// A run is cleared for one target id, which the run looks up in the trusted project's matrix and
// the plan's own targets. A target missing from either ends the run TargetUnavailable with
// not-declared, before any driver is asked, rather than leaving the target with no result at all.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planParser, runUntrusted, type RunResult } from "@revisum/engine";
import { fakePorts } from "#test-support/fakes/FakePorts.ts";
import { baseUrlOf } from "#test-support/policy-clearance.ts";
import { ORIGIN, signupPlan, withValue } from "./plan-examples.ts";
import {
    projectWith,
    runOnTarget,
    targetDriver,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "./target-examples.ts";

const DESKTOP = targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280");
const TABLET = targetInput("chromium-tablet", "fake-any", "chromium", "tablet-820");
const SMALL_MATRIX = [DESKTOP];
const LARGE_MATRIX = [DESKTOP, TABLET];

describe("Using the run", () => {
    describe("given a target the matrix declares but the plan does not name", () => {
        describe("when the run cleared for it runs", () => {
            test("then it should end TargetUnavailable with not-declared, asking no driver anything", async () => {
                const project = projectWith(LARGE_MATRIX);
                const driver = targetDriver("fake-any");
                const ran = await runOnTarget({
                    planProject: project,
                    trusted: await trustedProjectWith(LARGE_MATRIX),
                    planTargets: ["chromium-desktop"],
                    target: targetOf(project, "chromium-tablet"),
                    drivers: new Map([["fake-any", driver]]),
                });
                assert.equal(ran.result.state, "TargetUnavailable");
                assert.equal(ran.result.unavailable?.reason, "not-declared");
                assert.equal(ran.result.targetId, "chromium-tablet");
                assert.equal(driver.calls.count(), 0);
            });
        });
    });

    describe("given an untrusted plan naming a target the trusted project's matrix does not declare", () => {
        describe("when it is run", () => {
            test("then it should give that target a run ending TargetUnavailable with not-declared, beside the declared target's", async () => {
                const driver = targetDriver("fake-any");
                const outcome = await runUntrusted(
                    withValue(signupPlan(), ["targets"], ["chromium-desktop", "chromium-tablet"]),
                    planParser(projectWith(LARGE_MATRIX)),
                    {
                        project: projectWith(SMALL_MATRIX),
                        baseUrl: baseUrlOf(ORIGIN),
                        seed: 42,
                        fixedTimeMilliseconds: 0,
                        fixtures: [],
                        host: { platform: "test", arch: "test" },
                    },
                    fakePorts({ drivers: new Map([["fake-any", driver]]) }),
                );
                assert.ok(Array.isArray(outcome), JSON.stringify(outcome));
                const runs: readonly RunResult[] = outcome;
                assert.deepEqual(
                    runs.map((result) => [
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
    });
});
