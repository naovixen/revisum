// A plan a person has not approved must not reach production even by a request the page makes on its
// own, so production stays out of what the browser is allowed. An approved plan the project opens
// production to needs it there, or the run it was approved for can't work.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { createRunService, success, type BrowserDriver, type PlanStanding } from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../support/policy-clearance.ts";
import { parsedSignupPlan, withRepository } from "./approval-repositories.ts";
import {
    ORIGIN,
    TARGET_ID,
    testProject,
    testProjectInput,
    type JsonRecord,
} from "./plan-examples.ts";
import { fakeSessionOnOrders } from "./RunOnFakeSession.ts";
import { fakeDriver } from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";

const PRODUCTION_ORIGIN = "https://shop.example.com";
const OPEN_TO_APPROVED_PLANS: JsonRecord = { allowProductionForApprovedPlans: true };
const CLOSED_TO_APPROVED_PLANS: JsonRecord = { allowProductionForApprovedPlans: false };
const OPENED_ONCE = 1;

const projectFields = (policy: JsonRecord): JsonRecord => ({
    origins: [ORIGIN, PRODUCTION_ORIGIN],
    productionOrigins: [PRODUCTION_ORIGIN],
    policy,
});

async function approvedSignupStanding(): Promise<PlanStanding> {
    let standing: PlanStanding | undefined;
    await withRepository("solo", async (repository) => {
        const verified = await repository.verify(
            repository.subject("plan"),
            repository.lockdownProof(),
        );
        assert.ok(verified.ok, JSON.stringify(verified));
        standing = { mode: "approved", approval: verified.value.approval };
    });
    assert.ok(standing !== undefined, "the plan was approved");
    return standing;
}

// What the driver was told to allow, for the sign-up plan run on the test origin.
async function allowedOriginsOfRun(
    context: TestContext,
    policy: JsonRecord,
    standing: PlanStanding,
): Promise<readonly string[]> {
    const open = context.mock.fn<BrowserDriver["open"]>(() =>
        Promise.resolve(success(fakeSessionOnOrders())),
    );
    const driver = fakeDriver({ info: { id: "cdp", version: "fake", protocol: "none" }, open });
    const plan = parsedSignupPlan();
    const project = testProject({}, projectFields(policy));
    const target = project.matrix.find((candidate) => String(candidate.id) === TARGET_ID);
    assert.ok(target !== undefined, "the project has the plan's target");
    const cleared = clearRun(
        plan,
        await trustedProjectFrom(testProjectInput({}, projectFields(policy))),
        target.id,
        standing,
    );
    await createRunService(fakePorts({ drivers: driversOf(driver) })).run(cleared, {
        baseUrl: baseUrlOf(ORIGIN),
        seed: 7,
        fixedTimeMilliseconds: 0,
        fixtures: [],
        host: { platform: "test", arch: "test" },
    });
    assert.equal(open.mock.callCount(), OPENED_ONCE);
    const environment = open.mock.calls[0]?.arguments[1];
    assert.ok(environment !== undefined, "the driver was given an environment");
    return environment.allowedOrigins;
}

describe("Using the run", () => {
    describe("given a project with a production origin among its origins", () => {
        describe("and a proposal", () => {
            describe("when the run opens its browser", () => {
                test("then it should allow only the origins that are not production", async (context) => {
                    assert.deepEqual(
                        await allowedOriginsOfRun(context, OPEN_TO_APPROVED_PLANS, {
                            mode: "proposal",
                        }),
                        [ORIGIN],
                    );
                });
            });
        });

        describe("and an approved plan the project opens production to", () => {
            describe("when the run opens its browser", () => {
                test("then it should allow production too", async (context) => {
                    assert.deepEqual(
                        await allowedOriginsOfRun(
                            context,
                            OPEN_TO_APPROVED_PLANS,
                            await approvedSignupStanding(),
                        ),
                        [ORIGIN, PRODUCTION_ORIGIN],
                    );
                });
            });
        });

        describe("and an approved plan the project keeps production closed to", () => {
            describe("when the run opens its browser", () => {
                test("then it should allow only the origins that are not production", async (context) => {
                    assert.deepEqual(
                        await allowedOriginsOfRun(
                            context,
                            CLOSED_TO_APPROVED_PLANS,
                            await approvedSignupStanding(),
                        ),
                        [ORIGIN],
                    );
                });
            });
        });
    });
});
