// A replay on another machine differs in its manifest and so in its result hash, whatever it found. So
// a replay is told the state the recorded run ended in: one whose verdict changed is a mismatch, and
// only one with the same verdict is a per-environment baseline. Calling a Passed run that now Fails a
// baseline would hide a regression.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    planParser,
    replay,
    run,
    type ElementProbe,
    type Plan,
    type Project,
    type ReplayOutcome,
    type RunResult,
    type Session,
} from "@revisum/engine";
import { authorise, trustedProjectFrom } from "../../support/policy-clearance.ts";
import { NO_ELEMENT, SHOWN_ELEMENT, fakeSession } from "./RunOnFakeSession.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    OPEN_ORDERS,
    ORIGIN,
    accepted,
    planOf,
    projectFileWith,
    projectWith,
} from "./run-value-examples.ts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";

const THIS_MACHINE = { platform: "test", arch: "test" };
const OTHER_MACHINE = { platform: "linux", arch: "x64" };

const PLAN = planOf([OPEN_ORDERS]);

const showing = (probe: ElementProbe): Session =>
    fakeSession({ probe: () => Promise.resolve(probe) });

const portsOf = (session: Session) => fakePorts({ drivers: driversOf(fakeDriverOpening(session)) });

type Recorded = {
    readonly project: Project;
    readonly plan: Plan;
    readonly result: RunResult;
};

const record = async (probe: ElementProbe): Promise<Recorded> => {
    const project = projectWith();
    const trusted = await trustedProjectFrom(projectFileWith());
    const plan = authorise(accepted(planParser(project), PLAN), trusted);
    const result = await run(
        {
            plan,
            project,
            targetId: project.matrix[0]?.id ?? assert.fail("no target"),
            baseUrl: ORIGIN,
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: THIS_MACHINE,
        },
        portsOf(showing(probe)),
    );
    return { project, plan, result };
};

const replayOn = async (
    recorded: Recorded,
    host: { readonly platform: string; readonly arch: string },
    probe: ElementProbe,
): Promise<ReplayOutcome> => {
    const trusted = await trustedProjectFrom(projectFileWith());
    const manifest: unknown = JSON.parse(JSON.stringify(recorded.result.manifest));
    const request = {
        manifest,
        recording: null,
        recordedResultHash: recorded.result.resultHash,
        recordedState: recorded.result.state,
        inputs: {
            plan: authorise(recorded.plan, trusted),
            project: recorded.project,
            targetId: recorded.project.matrix[0]?.id ?? assert.fail("no target"),
            baseUrl: ORIGIN,
            host,
        },
    };
    const ports = { ...portsOf(showing(probe)), fixtures: { read: () => Promise.resolve(null) } };
    const answer = await replay(request, ports);
    assert.ok(answer.ok, JSON.stringify(answer));
    return answer.value;
};

describe("Using a replay", () => {
    describe("given a run recorded Passed", () => {
        describe("and a replay on another machine whose check now fails", () => {
            describe("when the replay ends", () => {
                test("then it should say mismatch, not per-environment-baseline", async () => {
                    const recorded = await record(SHOWN_ELEMENT);
                    assert.equal(recorded.result.state, "Passed");
                    const outcome = await replayOn(recorded, OTHER_MACHINE, NO_ELEMENT);
                    assert.deepEqual(outcome.differingInputs, ["host"]);
                    assert.equal(outcome.identical, false);
                    assert.equal(outcome.verdict, "mismatch");
                });
            });
        });

        describe("and a replay on another machine whose check still passes", () => {
            describe("when the replay ends", () => {
                test("then it should say per-environment-baseline", async () => {
                    const recorded = await record(SHOWN_ELEMENT);
                    const outcome = await replayOn(recorded, OTHER_MACHINE, SHOWN_ELEMENT);
                    assert.deepEqual(outcome.differingInputs, ["host"]);
                    assert.equal(outcome.verdict, "per-environment-baseline");
                });
            });
        });

        describe("and a replay on this machine whose check still passes", () => {
            describe("when the replay ends", () => {
                test("then it should say identical", async () => {
                    const recorded = await record(SHOWN_ELEMENT);
                    const outcome = await replayOn(recorded, THIS_MACHINE, SHOWN_ELEMENT);
                    assert.equal(outcome.verdict, "identical");
                });
            });
        });
    });

    describe("given a run recorded Failed", () => {
        describe("and a replay on another machine whose check now passes", () => {
            describe("when the replay ends", () => {
                test("then it should say mismatch", async () => {
                    const recorded = await record(NO_ELEMENT);
                    assert.equal(recorded.result.state, "Failed");
                    const outcome = await replayOn(recorded, OTHER_MACHINE, SHOWN_ELEMENT);
                    assert.equal(outcome.verdict, "mismatch");
                });
            });
        });

        describe("and a replay on another machine whose check still fails", () => {
            describe("when the replay ends", () => {
                test("then it should say per-environment-baseline", async () => {
                    const recorded = await record(NO_ELEMENT);
                    const outcome = await replayOn(recorded, OTHER_MACHINE, NO_ELEMENT);
                    assert.equal(outcome.verdict, "per-environment-baseline");
                });
            });
        });
    });
});
