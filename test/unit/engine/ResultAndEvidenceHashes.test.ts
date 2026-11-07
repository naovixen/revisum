// A run result carries two hashes. The result hash, which replay compares, leaves out the blocked origins,
// because a request sent as a run ends can change that list and nothing else. The evidence hash covers
// the whole result, list included, so a list edited after the run shows when the hash is recomputed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRunService,
    evidenceResult,
    failure,
    planParser,
    recordRead,
    refusedSuiteResult,
    unreadSuiteResult,
    type RunResult,
} from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../support/policy-clearance.ts";
import {
    evidenceHashOf,
    expectedEvidenceHash,
    expectedResultHash,
    storedCopy,
} from "../../support/ExpectedEvidenceHash.ts";
import {
    SUITE_NAME,
    declaredCheckoutSuite,
    decodedReport,
    recordedReport,
    type JsonRecord,
    evidenceContext,
    specPath,
} from "./evidence-examples.ts";
import { withValue } from "./plan-examples.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
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
import { OPEN_CART, unsafePlan } from "./unsafe-feature-steps.ts";
import { fakeDriver } from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";

const EARLY_ORIGIN = "https://early.example.test";
const LATE_ORIGIN = "https://late.example.test";
const UNSEEN_ORIGIN = "https://unseen.example.test";

const REFUSED_ORIGINS: readonly string[] = [EARLY_ORIGIN, LATE_ORIGIN];
const FEWER_REFUSED_ORIGINS: readonly string[] = [EARLY_ORIGIN];

const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "textEquals", value: "Not shown" },
    criterionId: "status.text-shown",
};

const planRunRefusing = async (
    origins: readonly string[],
    steps: readonly JsonRecord[] = [OPEN_CART],
): Promise<RunResult> => {
    const { result } = await runOnFakeSession(unsafePlan(steps), {
        session: fakeSessionOnOrders({ blockedOrigins: () => origins }),
    });
    return result;
};

const firstTestResult = (field: string): (string | number)[] => [
    ...specPath(0),
    "tests",
    0,
    "results",
    0,
    field,
];

const evidenceRunRefusing = (
    origins: readonly string[],
    report: JsonRecord = recordedReport("passing-with-criteria"),
): Promise<RunResult> =>
    Promise.resolve(
        evidenceResult(decodedReport(report), [], [], {
            ...evidenceContext(report),
            egress: recordRead(origins),
        }),
    );

const failingSuiteReport = (): JsonRecord =>
    withValue(recordedReport("passing-with-criteria"), firstTestResult("status"), "failed");

type RunKind = {
    readonly name: string;
    readonly refusing: (origins: readonly string[]) => Promise<RunResult>;
    // A run that refused the same origins, in which something the run was testing went the other way.
    readonly failingAndRefusing: (origins: readonly string[]) => Promise<RunResult>;
    // What someone would change to turn that failure into a pass, after the run.
    readonly withOutcomeEdited: (result: RunResult) => object;
};

const RUN_KINDS: readonly RunKind[] = [
    {
        name: "a plan run",
        refusing: planRunRefusing,
        failingAndRefusing: (origins) => planRunRefusing(origins, [OPEN_CART, FAILING_CHECK]),
        withOutcomeEdited: (result) => ({
            ...result,
            steps: result.steps.map((step) => ({ ...step, outcome: "passed" })),
        }),
    },
    {
        name: "an evidence run",
        refusing: evidenceRunRefusing,
        failingAndRefusing: (origins) => evidenceRunRefusing(origins, failingSuiteReport()),
        withOutcomeEdited: (result) => ({
            ...result,
            suite: {
                ...result.suite,
                tests: result.suite?.tests.map((entry) => ({ ...entry, outcome: "passed" })),
            },
        }),
    },
];

type ListEdit = { readonly name: string; readonly origins: readonly string[] };

const LIST_EDITS: readonly ListEdit[] = [
    { name: "an origin is removed from the list", origins: FEWER_REFUSED_ORIGINS },
    { name: "an origin is added to the list", origins: [...REFUSED_ORIGINS, UNSEEN_ORIGIN] },
    { name: "the list is emptied", origins: [] },
    { name: "the list is reordered", origins: REFUSED_ORIGINS.toReversed() },
];

const unavailableDriver = fakeDriver({
    supports: () => failure({ reason: "engine-not-supported", detail: "not this engine" }),
    open: () => assert.fail("a target that is unavailable is never opened"),
});

const planRunOnAnUnavailableTarget = async (): Promise<RunResult> => {
    const project = projectWith();
    const trusted = await trustedProjectFrom(projectFileWith());
    const plan = accepted(planParser(project), planOf([OPEN_ORDERS]));
    return createRunService(fakePorts({ drivers: driversOf(unavailableDriver) })).run(
        clearRun(plan, trusted, project.matrix[0]?.id ?? assert.fail("no target")),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
        },
    );
};

const unreadSuiteRun = (): RunResult => {
    const report = recordedReport("passing-with-criteria");
    return unreadSuiteResult(
        {
            ...evidenceContext(report, { suite: declaredCheckoutSuite() }),
            egress: recordRead(REFUSED_ORIGINS),
        },
        "suite-report-unread",
    );
};

const refusedSuiteRun = (): RunResult =>
    refusedSuiteResult(SUITE_NAME, { code: "egress-unenforceable" });

const OTHER_ENDINGS: readonly {
    readonly name: string;
    readonly state: string;
    readonly end: () => RunResult | Promise<RunResult>;
}[] = [
    {
        name: "a plan run on a target that is unavailable",
        state: "TargetUnavailable",
        end: planRunOnAnUnavailableTarget,
    },
    { name: "a suite run whose report could not be read", state: "Errored", end: unreadSuiteRun },
    { name: "a suite run refused before it started", state: "Refused", end: refusedSuiteRun },
];

describe("Using the result hash and the evidence hash", () => {
    for (const kind of RUN_KINDS) {
        describe(`given ${kind.name} that refused two origins`, () => {
            describe("when the run ends", () => {
                test("then it should keep the list, the timings and the manifest body in the result", async () => {
                    const result = await kind.refusing(REFUSED_ORIGINS);
                    assert.deepEqual(result.blockedOrigins, REFUSED_ORIGINS);
                    assert.notEqual(result.manifest, null);
                    assert.equal(typeof result.timings.totalMilliseconds, "number");
                });

                test("then it should hash all but the list, the timings and the manifest body as the result hash", async () => {
                    const result = await kind.refusing(REFUSED_ORIGINS);
                    assert.equal(result.resultHash, expectedResultHash(result));
                });

                test("then it should hash all but the timings and the manifest body as the evidence hash", async () => {
                    const result = await kind.refusing(REFUSED_ORIGINS);
                    assert.equal(evidenceHashOf(result), expectedEvidenceHash(result));
                });
            });

            describe("and the same run again", () => {
                describe("when both have ended", () => {
                    test("then it should give both the same two hashes", async () => {
                        const first = await kind.refusing(REFUSED_ORIGINS);
                        const second = await kind.refusing(REFUSED_ORIGINS);
                        assert.equal(second.resultHash, first.resultHash);
                        assert.equal(evidenceHashOf(second), evidenceHashOf(first));
                    });
                });
            });

            describe("and another run that differs only in refusing one of them", () => {
                describe("when both have ended", () => {
                    test("then it should give both the same result hash", async () => {
                        const both = await kind.refusing(REFUSED_ORIGINS);
                        const one = await kind.refusing(FEWER_REFUSED_ORIGINS);
                        assert.deepEqual(one.blockedOrigins, FEWER_REFUSED_ORIGINS);
                        assert.equal(one.resultHash, both.resultHash);
                    });

                    test("then it should give each the evidence hash of its own list", async () => {
                        const both = await kind.refusing(REFUSED_ORIGINS);
                        const one = await kind.refusing(FEWER_REFUSED_ORIGINS);
                        assert.equal(evidenceHashOf(both), expectedEvidenceHash(both));
                        assert.equal(evidenceHashOf(one), expectedEvidenceHash(one));
                        assert.notEqual(evidenceHashOf(one), evidenceHashOf(both));
                    });
                });
            });

            describe("and another run of those origins that failed", () => {
                describe("when both have ended", () => {
                    test("then it should give the failed run another result hash", async () => {
                        const passed = await kind.refusing(REFUSED_ORIGINS);
                        const failed = await kind.failingAndRefusing(REFUSED_ORIGINS);
                        assert.equal(passed.state, "Passed");
                        assert.equal(failed.state, "Failed");
                        assert.deepEqual(failed.blockedOrigins, passed.blockedOrigins);
                        assert.notEqual(failed.resultHash, passed.resultHash);
                        assert.equal(failed.resultHash, expectedResultHash(failed));
                    });

                    test("then it should give the failed run another evidence hash", async () => {
                        const passed = await kind.refusing(REFUSED_ORIGINS);
                        const failed = await kind.failingAndRefusing(REFUSED_ORIGINS);
                        assert.notEqual(evidenceHashOf(failed), evidenceHashOf(passed));
                        assert.equal(evidenceHashOf(failed), expectedEvidenceHash(failed));
                    });
                });
            });

            describe("and a stored copy of its result", () => {
                describe("when nothing has been edited", () => {
                    test("then it should recompute to both stored hashes", async () => {
                        const result = await kind.refusing(REFUSED_ORIGINS);
                        const stored = storedCopy(result);
                        assert.equal(expectedResultHash(stored), result.resultHash);
                        assert.equal(expectedEvidenceHash(stored), evidenceHashOf(result));
                    });
                });

                for (const edit of LIST_EDITS) {
                    describe(`when ${edit.name}`, () => {
                        test("then it should no longer recompute to the stored evidence hash", async () => {
                            const result = await kind.refusing(REFUSED_ORIGINS);
                            const edited = storedCopy({ ...result, blockedOrigins: edit.origins });
                            assert.notEqual(expectedEvidenceHash(edited), evidenceHashOf(result));
                        });

                        test("then it should still recompute to the stored result hash, which leaves the list out", async () => {
                            const result = await kind.refusing(REFUSED_ORIGINS);
                            const edited = storedCopy({ ...result, blockedOrigins: edit.origins });
                            assert.equal(expectedResultHash(edited), result.resultHash);
                        });
                    });
                }

                describe("when a failed outcome is edited", () => {
                    test("then it should no longer recompute to either stored hash", async () => {
                        const result = await kind.failingAndRefusing(REFUSED_ORIGINS);
                        const edited = storedCopy(kind.withOutcomeEdited(result));
                        assert.notEqual(expectedResultHash(edited), result.resultHash);
                        assert.notEqual(expectedEvidenceHash(edited), evidenceHashOf(result));
                    });
                });
            });
        });
    }

    describe("given an evidence run and another that differs only in how long a test took", () => {
        describe("when both have ended", () => {
            test("then it should give both the same two hashes", async () => {
                const quick = await evidenceRunRefusing(REFUSED_ORIGINS);
                const slow = await evidenceRunRefusing(
                    REFUSED_ORIGINS,
                    withValue(
                        recordedReport("passing-with-criteria"),
                        firstTestResult("duration"),
                        987_654,
                    ),
                );
                assert.notDeepEqual(slow.timings, quick.timings);
                assert.equal(slow.resultHash, quick.resultHash);
                assert.equal(evidenceHashOf(slow), evidenceHashOf(quick));
            });
        });
    });

    for (const ending of OTHER_ENDINGS) {
        describe(`given ${ending.name}`, () => {
            describe("when its result is made", () => {
                test("then it should hold both hashes, each over its own fields", async () => {
                    const result = await ending.end();
                    assert.equal(result.state, ending.state);
                    assert.equal(result.resultHash, expectedResultHash(result));
                    assert.equal(evidenceHashOf(result), expectedEvidenceHash(result));
                });
            });
        });
    }
});
