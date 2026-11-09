// Only the approval verifier mints an Approval. The type says so, but a copy read back from JSON has
// the same fields and the plan's own hash, and it says nothing about who checked what. It must leave
// the plan a proposal, wherever a standing is judged.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ownStanding, planHash, type Approval, type PlanStanding } from "@revisum/engine";
import { parsedSignupPlan, withRepository } from "./examples/MemoryApprovalStore.ts";
import {
    ALLOWED,
    PRODUCTION_ORIGIN,
    decideOn,
    comparable,
    denied,
    navigate,
    parsedPlan,
    planOf,
    policyProjectInput,
    testGate,
    withPolicy,
    approvedStanding,
} from "../policy/examples/Policy.ts";

const PROPOSAL = { mode: "proposal" };

const verifiedApproval = async (): Promise<Approval> => {
    let approval: Approval | undefined;
    await withRepository("solo", async (repository) => {
        const verified = await repository.verify(
            repository.subject("plan"),
            repository.lockdownProof(),
        );
        assert.ok(verified.ok, JSON.stringify(verified));
        approval = verified.value.approval;
    });
    return approval ?? assert.fail("no approval");
};

const loadedFromJson = (approval: Approval): Approval => ({
    ...approval,
    ...(JSON.parse(JSON.stringify(approval)) as object),
});

const COPIES: readonly {
    readonly name: string;
    readonly copy: (approval: Approval) => Approval;
}[] = [
    { name: "read back from JSON", copy: loadedFromJson },
    { name: "copied field by field", copy: (approval) => ({ ...approval }) },
    { name: "cloned", copy: (approval) => structuredClone(approval) },
];

const standingOf = (approval: Approval): PlanStanding => ({ mode: "approved", approval });

const PRODUCTION_PLAN = planOf([navigate(`${PRODUCTION_ORIGIN}/account`)]);
const PRODUCTION_OPEN = withPolicy({ allowProductionForApprovedPlans: true });

describe("Using a plan's standing", () => {
    for (const { name, copy } of COPIES) {
        describe(`given an approval of the plan's own hash, ${name}`, () => {
            describe("when the plan's own standing is worked out", () => {
                test("then it should leave the plan a proposal", async () => {
                    const approval = await verifiedApproval();
                    const plan = parsedSignupPlan();
                    assert.equal(approval.subject.hash, planHash(plan));
                    assert.deepEqual(ownStanding(plan, standingOf(copy(approval))), PROPOSAL);
                });
            });
        });
    }

    describe("given the approval the verifier minted for the plan's own hash", () => {
        describe("when the plan's own standing is worked out", () => {
            test("then it should keep the plan approved", async () => {
                const approval = await verifiedApproval();
                const standing = standingOf(approval);
                assert.equal(ownStanding(parsedSignupPlan(), standing), standing);
            });
        });
    });
});

describe("Using the policy gate", () => {
    describe("given a plan reaching production, under a project that opens production to approved plans", () => {
        describe("and an approval of the plan's own hash, read back from JSON", () => {
            describe("when the plan is decided", () => {
                test("then it should deny it as a proposal", async () => {
                    const tested = await testGate(PRODUCTION_OPEN);
                    const plan = parsedPlan(PRODUCTION_PLAN, PRODUCTION_OPEN);
                    const minted = await approvedStanding(plan);
                    assert.ok(minted.mode === "approved");
                    const decision = decideOn(
                        tested,
                        plan,
                        standingOf(loadedFromJson(minted.approval)),
                    );
                    assert.deepEqual(comparable(decision), denied("production-origin", 0));
                });
            });
        });

        describe("and the approval the verifier minted", () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", async () => {
                    const tested = await testGate(PRODUCTION_OPEN);
                    const plan = parsedPlan(PRODUCTION_PLAN, PRODUCTION_OPEN);
                    const decision = decideOn(tested, plan, await approvedStanding(plan));
                    assert.deepEqual(comparable(decision), ALLOWED);
                });
            });
        });
    });

    describe("given the same plan under a project that keeps production closed", () => {
        describe("when the plan is decided with no approval", () => {
            test("then it should deny it", async () => {
                const tested = await testGate();
                const plan = parsedPlan(PRODUCTION_PLAN, policyProjectInput());
                assert.deepEqual(
                    comparable(decideOn(tested, plan)),
                    denied("production-origin", 0),
                );
            });
        });
    });
});
