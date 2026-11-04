// A request a page sends as a run ends may or may not be refused before the session closes, so a replay
// can see other refused origins from the run it repeats. Replay compares the result hash, which leaves
// that list out, so such a replay is identical. Any other difference is still a mismatch.
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
import { evidenceHashOf } from "../../support/ExpectedEvidenceHash.ts";
import { NO_ELEMENT, SHOWN_ELEMENT, fakeSessionOnOrders } from "./RunOnFakeSession.ts";
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

const EARLY_ORIGIN = "https://early.example.test";
const LATE_ORIGIN = "https://late.example.test";
const OTHER_LATE_ORIGIN = "https://other-late.example.test";
const RECORDED_ORIGINS: readonly string[] = [EARLY_ORIGIN, LATE_ORIGIN];

const PLAN = planOf([OPEN_ORDERS]);

const HIDDEN_ELEMENT: ElementProbe = {
    count: 1,
    visible: false,
    enabled: true,
    text: "Ready",
    value: "Ready",
    sensitive: false,
    box: null,
};

type PageState = { readonly probe: ElementProbe; readonly origins: readonly string[] };

const sessionOn = ({ probe, origins }: PageState): Session =>
    fakeSessionOnOrders({ probe: () => Promise.resolve(probe), blockedOrigins: () => origins });

const portsOn = (page: PageState) =>
    fakePorts({ drivers: driversOf(fakeDriverOpening(sessionOn(page))) });

type Recorded = {
    readonly project: Project;
    readonly plan: Plan;
    readonly result: RunResult;
};

const record = async (page: PageState): Promise<Recorded> => {
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
        portsOn(page),
    );
    return { project, plan, result };
};

const replayOn = async (
    recorded: Recorded,
    page: PageState,
    recordedResultHash: string = recorded.result.resultHash,
): Promise<ReplayOutcome> => {
    const trusted = await trustedProjectFrom(projectFileWith());
    const manifest: unknown = JSON.parse(JSON.stringify(recorded.result.manifest));
    const answer = await replay(
        {
            manifest,
            recording: null,
            recordedResultHash,
            recordedState: recorded.result.state,
            inputs: {
                plan: authorise(recorded.plan, trusted),
                project: recorded.project,
                targetId: recorded.project.matrix[0]?.id ?? assert.fail("no target"),
                baseUrl: ORIGIN,
                host: THIS_MACHINE,
            },
        },
        { ...portsOn(page), fixtures: { read: () => Promise.resolve(null) } },
    );
    assert.ok(answer.ok, JSON.stringify(answer));
    return answer.value;
};

const RECORDED_PAGE: PageState = { probe: SHOWN_ELEMENT, origins: RECORDED_ORIGINS };

const OTHER_LISTS: readonly { readonly name: string; readonly origins: readonly string[] }[] = [
    { name: "fewer origins", origins: [EARLY_ORIGIN] },
    { name: "more origins", origins: [...RECORDED_ORIGINS, OTHER_LATE_ORIGIN].sort() },
    { name: "another late origin", origins: [EARLY_ORIGIN, OTHER_LATE_ORIGIN] },
    { name: "no origins", origins: [] },
];

describe("Using a replay", () => {
    describe("given a run recorded Passed that refused two origins", () => {
        for (const list of OTHER_LISTS) {
            describe(`and a replay that passes and refused ${list.name}`, () => {
                describe("when the replay ends", () => {
                    test("then it should say identical", async () => {
                        const recorded = await record(RECORDED_PAGE);
                        const outcome = await replayOn(recorded, {
                            probe: SHOWN_ELEMENT,
                            origins: list.origins,
                        });
                        assert.deepEqual(outcome, {
                            identical: true,
                            resultHash: recorded.result.resultHash,
                            manifestHash: recorded.result.manifestHash,
                            differingInputs: [],
                            verdict: "identical",
                        });
                    });
                });
            });
        }

        describe("and a replay that refused the same origins and whose check now fails", () => {
            describe("when the replay ends", () => {
                test("then it should say mismatch", async () => {
                    const recorded = await record(RECORDED_PAGE);
                    const outcome = await replayOn(recorded, {
                        probe: NO_ELEMENT,
                        origins: RECORDED_ORIGINS,
                    });
                    assert.equal(outcome.identical, false);
                    assert.equal(outcome.verdict, "mismatch");
                    assert.notEqual(outcome.resultHash, recorded.result.resultHash);
                });
            });
        });

        describe("and a replay given the recorded evidence hash in place of its result hash", () => {
            describe("when the replay ends", () => {
                test("then it should say mismatch, since it compares only result hashes", async () => {
                    const recorded = await record(RECORDED_PAGE);
                    const outcome = await replayOn(
                        recorded,
                        RECORDED_PAGE,
                        evidenceHashOf(recorded.result),
                    );
                    assert.equal(outcome.identical, false);
                    assert.equal(outcome.verdict, "mismatch");
                });
            });
        });
    });

    describe("given a run recorded Failed because an element was missing", () => {
        describe("and a replay that refused other origins and fails because the element is hidden", () => {
            describe("when the replay ends", () => {
                test("then it should say mismatch, though it ended in the same state", async () => {
                    const recorded = await record({
                        probe: NO_ELEMENT,
                        origins: RECORDED_ORIGINS,
                    });
                    assert.equal(recorded.result.state, "Failed");
                    const outcome = await replayOn(recorded, {
                        probe: HIDDEN_ELEMENT,
                        origins: [EARLY_ORIGIN],
                    });
                    assert.equal(outcome.identical, false);
                    assert.equal(outcome.verdict, "mismatch");
                });
            });
        });
    });
});
