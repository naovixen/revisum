// A clock is only for wall-clock timings a result doesn't hash, so a clock that throws must not
// reject a run: however far it got, the run still gives a result.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRunService,
    planParser,
    policyGate,
    type Clock,
    type PlanRunResult,
    type TargetId,
} from "@revisum/engine";
import { fakeDriverNeverLaunching } from "#test-support/fakes/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/policy-clearance.ts";
import { targetNotDeclaredResult } from "../../../packages/engine/src/run/seal/TargetNotDeclaredResult.ts";
import { ORIGIN } from "./plan-examples.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    OPEN_ORDERS,
    accepted,
    planOf,
    projectFileWith,
    projectWith,
    recordingDriver,
} from "./run-value-examples.ts";

const WHY_THE_CLOCK_THREW = "the clock has failed";

const throwingAfter = (goodReads: number): Clock => {
    let reads = 0;
    return {
        now: () => {
            reads += 1;
            if (reads > goodReads) {
                throw new Error(WHY_THE_CLOCK_THREW);
            }
            return reads;
        },
        sleep: () => Promise.resolve(),
    };
};

const INPUTS = {
    baseUrl: baseUrlOf(ORIGIN),
    seed: DEFAULT_SEED,
    fixedTimeMilliseconds: DEFAULT_CLOCK_START,
    fixtures: [],
    host: { platform: "test", arch: "test" },
};

async function clearedPlan() {
    const plan = accepted(planParser(projectWith()), planOf([OPEN_ORDERS]));
    const [targetId = assert.fail("the test plan declares a target")] = plan.targets;
    return {
        plan,
        targetId,
        cleared: clearRun(plan, await trustedProjectFrom(projectFileWith()), targetId),
    };
}

async function runWith(clock: Clock, isDriverWorking: boolean): Promise<PlanRunResult> {
    const { cleared } = await clearedPlan();
    const driver = isDriverWorking ? recordingDriver().driver : fakeDriverNeverLaunching();
    return createRunService(fakePorts({ drivers: driversOf(driver), clock })).run(cleared, INPUTS);
}

const hasAResult = (result: PlanRunResult): void => {
    assert.equal(typeof result.state, "string");
};

describe("Using a run", () => {
    describe("given a clock that throws on its first read", () => {
        describe("when a run happens", () => {
            test("then it should end with a result", async () => {
                hasAResult(await runWith(throwingAfter(0), true));
            });
        });

        describe("and a driver that never launches", () => {
            describe("when a run happens", () => {
                test("then it should end with a result", async () => {
                    hasAResult(await runWith(throwingAfter(0), false));
                });
            });
        });
    });

    describe("given a clock that works for the first read and then throws", () => {
        describe("and a driver that never launches", () => {
            describe("when a run that never reached a step ends", () => {
                test("then it should end with a result", async () => {
                    hasAResult(await runWith(throwingAfter(1), false));
                });
            });
        });

        describe("when a run reaches the end of its steps", () => {
            test("then it should end with a result", async () => {
                hasAResult(await runWith(throwingAfter(1), true));
            });
        });
    });

    describe("given a target the plan does not declare and a clock that throws", () => {
        describe("when its result is made", () => {
            test("then it should give the not-declared result", async () => {
                const { plan } = await clearedPlan();
                const project = await trustedProjectFrom(projectFileWith());
                const clearance = policyGate({ project, events: fakeEventSink() }).clear(
                    plan,
                    "a-target-the-plan-does-not-name" as TargetId,
                );
                assert.ok(clearance.kind === "not-declared", JSON.stringify(clearance));
                const result = targetNotDeclaredResult(
                    clearance,
                    DEFAULT_SEED,
                    fakePorts({ clock: throwingAfter(0) }),
                );
                assert.equal(result.state, "TargetUnavailable");
            });
        });
    });
});
