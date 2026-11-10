// A replay takes its clock start from the manifest it is handed. A clock outside what a Date can
// hold cannot have been recorded by a run, so the replay says it does not match, whether it finds
// that out from the manifest or from the replayed run. It never rejects part way through.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { goldenPlan } from "../plan/examples/GoldenPlan.ts";
import {
    DEFAULT_CLOCK_START,
    closedScenario,
    removeFakeExecutables,
    replayRun,
    replayed,
    runScenario,
    type ReplayAnswer,
    type ScenarioRun,
} from "./examples/ManifestUnderTest.ts";
import {
    OPEN_ORDERS,
    planOf,
    projectFileWith,
    type JsonRecord,
} from "../run/values/examples/RunPlan.ts";

after(removeFakeExecutables);

const LATEST_DATE_MILLISECONDS = 8_640_000_000_000_000;
const ONE_DAY_MILLISECONDS = 86_400_000;

const CLOCKS_OUTSIDE_THE_RANGE: readonly number[] = [
    LATEST_DATE_MILLISECONDS + 1,
    -LATEST_DATE_MILLISECONDS - 1,
    Number.MAX_SAFE_INTEGER,
];

// Whether a run reads the clock start as a date depends on the plan.
const PLANS: readonly { readonly name: string; readonly plan: JsonRecord }[] = [
    { name: "a plan with dates and a plan clock", plan: goldenPlan("booking-next-month") },
    { name: "a plan with no dates", plan: planOf([OPEN_ORDERS]) },
];

const runOf = (plan: JsonRecord): Promise<ScenarioRun> =>
    runScenario(closedScenario(projectFileWith(), plan));

const manifestWithClock = (ran: ScenarioRun, fixedTimeMilliseconds: number): unknown => ({
    ...JSON.parse(JSON.stringify(ran.manifest)),
    clock: { fixedTimeMilliseconds },
});

const saidNoMatch = (answer: ReplayAnswer): boolean =>
    answer.ok ? answer.value.verdict === "mismatch" : answer.error.code === "replay-mismatch";

describe("Using a replay", () => {
    for (const { name, plan } of PLANS) {
        for (const clock of CLOCKS_OUTSIDE_THE_RANGE) {
            describe(`given ${name}, and a manifest whose clock start is ${clock}`, () => {
                describe("when the run is replayed", () => {
                    test("then it should say it does not match, and not reject", async () => {
                        const ran = await runOf(plan);
                        const { answer } = await replayRun(ran, {
                            manifest: manifestWithClock(ran, clock),
                        });
                        assert.equal(saidNoMatch(answer), true, JSON.stringify(answer));
                    });
                });
            });
        }

        describe(`given ${name}, and a manifest whose clock start is a day later`, () => {
            describe("when the run is replayed", () => {
                test("then it should answer that it does not match", async () => {
                    const ran = await runOf(plan);
                    const { answer } = await replayRun(ran, {
                        manifest: manifestWithClock(
                            ran,
                            DEFAULT_CLOCK_START + ONE_DAY_MILLISECONDS,
                        ),
                    });
                    assert.equal(replayed(answer).verdict, "mismatch");
                });
            });
        });

        describe(`given ${name}, and the run's own manifest`, () => {
            describe("when the run is replayed", () => {
                test("then it should answer identical", async () => {
                    const ran = await runOf(plan);
                    const { answer } = await replayRun(ran);
                    assert.equal(replayed(answer).verdict, "identical");
                });
            });
        });
    }
});
