// An explore draft goes through the one door every draft goes through: admitCoreDraft records it
// with source explore-draft, basis core-recorded and the page map's sha256 as its reference, and
// the source changes nothing else. The same plan admitted under any other source gets the same
// hash, the same policy decision and the same approval requirement: unapproved it stands as a
// proposal, and only an approval of its own hash makes it approved. No author may declare
// explore-draft, since only core's own explore route records it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    admitCoreDraft,
    admitDraft,
    planHash,
    planStanding,
    policyGate,
    unverified,
    writePlanText,
    type Plan,
    type PlanDraft,
    type PlanParse,
} from "@revisum/engine";
import {
    memoryApprovalStore,
    memoryEventSink,
    parsedSignupPlan,
    withRepository,
} from "../approval/examples/MemoryApprovalStore.ts";
import {
    defaultParser,
    signupPlan,
    testProject,
    withValue,
    type JsonRecord,
} from "../plan/examples/GoldenPlan.ts";
import { PolicyVerdictKind, ApprovalSubjectKind, PlanSource, PlanFormat } from "@revisum/contracts";

// The page map's reference, as the command records it.
const PAGE_MAP_REFERENCE = `sha256:${"5e".repeat(32)}`;

// A route only core records, or the hand-written route an author may declare.
type CoreRouteSource = Parameters<typeof admitCoreDraft>[1]["source"];
type AdmittedSource = "hand-written" | CoreRouteSource;

const textOf = (plan: JsonRecord): string => {
    const parsed = defaultParser()(plan);
    if (!parsed.ok) {
        assert.fail(`the fixture plan was refused: ${JSON.stringify(parsed.error)}`);
    }
    return writePlanText(parsed.value);
};
const draftOf = (plan: JsonRecord): PlanDraft => ({
    format: PlanFormat.Text,
    content: textOf(plan),
});

test("an explore draft is admitted with source explore-draft, basis core-recorded and the page map's sha256 as its reference", () => {
    const events = memoryEventSink();
    const admitted = admitCoreDraft(
        draftOf(signupPlan()),
        { source: "explore-draft", reference: PAGE_MAP_REFERENCE },
        defaultParser(),
        events,
    );
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.deepEqual(
        events.recorded.map(({ event }) => event.kind),
        ["plan.submitted"],
    );
    assert.deepEqual(events.recorded[0]?.event.planProvenance, {
        source: "explore-draft",
        basis: "core-recorded",
        reference: PAGE_MAP_REFERENCE,
    });
});

test("the explore route is recorded as an agent, never as a person", () => {
    const events = memoryEventSink();
    admitCoreDraft(
        draftOf(signupPlan()),
        { source: "explore-draft", reference: PAGE_MAP_REFERENCE },
        defaultParser(),
        events,
    );
    assert.equal(events.recorded[0]?.actor.actorType, "agent");
});

test("a draft that declares itself an explore draft is refused with untrusted-source, before the parser", () => {
    let parses = 0;
    const counting: PlanParse = (input) => {
        parses += 1;
        return defaultParser()(input);
    };
    for (const basis of ["declared", "core-recorded"] as const) {
        const claimed: PlanDraft = {
            ...draftOf(signupPlan()),
            provenance: { source: PlanSource.ExploreDraft, basis, reference: PAGE_MAP_REFERENCE },
        };
        const admitted = admitDraft(
            claimed,
            counting,
            memoryEventSink(),
            unverified(
                { kind: ApprovalSubjectKind.Plan, hash: planHash(parsedSignupPlan()) },
                "local",
            ),
        );
        if (admitted.ok) {
            assert.fail(`an author could declare explore-draft, basis ${basis}`);
        }
        assert.ok(
            JSON.stringify(admitted.error).includes("untrusted-source"),
            JSON.stringify(admitted.error),
        );
    }
    assert.equal(parses, 0, "the parser saw a draft whose source was refused");
});

// What a source could change, if it were trusted: the hash, the gate's decision, and the standing
// without an approval and with the sign-up plan's approval.
type Treatment = {
    readonly hash: string;
    readonly decision: string;
    readonly withoutApproval: string;
    readonly withTheSignUpApproval: string;
};

async function treatmentOf(plan: Plan): Promise<Treatment> {
    const project = testProject();
    const decision = policyGate({ project, events: memoryEventSink() }).decide(
        plan,
        project.matrix.map((target) => target.id),
    );
    let approvedStanding = "";
    await withRepository("solo", async (repository) => {
        const verified = await repository.verify(
            repository.subject("plan"),
            repository.lockdownProof(),
        );
        if (!verified.ok) {
            throw new Error(`the sign-up plan was not approved: ${verified.error}`);
        }
        approvedStanding = planStanding(plan, memoryApprovalStore([verified.value.approval])).mode;
    });
    return {
        hash: planHash(plan),
        decision:
            decision.kind === PolicyVerdictKind.Deny
                ? `deny ${decision.rule} at ${String(decision.stepIndex)}`
                : "allow",
        withoutApproval: planStanding(plan, memoryApprovalStore([])).mode,
        withTheSignUpApproval: approvedStanding,
    };
}

function admittedUnder(source: AdmittedSource, plan: JsonRecord): Plan {
    const draft = draftOf(plan);
    const admitted =
        source === "hand-written"
            ? admitDraft(
                  draft,
                  defaultParser(),
                  memoryEventSink(),
                  unverified(
                      { kind: ApprovalSubjectKind.Plan, hash: planHash(parsedSignupPlan()) },
                      "local",
                  ),
              )
            : admitCoreDraft(
                  draft,
                  {
                      source,
                      reference:
                          source === "explore-draft" ? PAGE_MAP_REFERENCE : "specs/signup.md",
                  },
                  defaultParser(),
                  memoryEventSink(),
              );
    if (!admitted.ok) {
        assert.fail(`${source}: ${JSON.stringify(admitted.error)}`);
    }
    return admitted.value;
}

const DENIED_SIGNUP = (): JsonRecord =>
    withValue(signupPlan(), ["steps", 8, "locator", "name"], "Konto löschen");
const SOURCES: readonly AdmittedSource[] = [
    "explore-draft",
    "hand-written",
    "draft-command",
    "ticket",
    "chat",
];

for (const { name, plan, decision, approved } of [
    { name: "the sign-up plan", plan: signupPlan, decision: "allow", approved: "approved" },
    {
        name: "the sign-up plan with an irreversible click",
        plan: DENIED_SIGNUP,
        decision: "deny irreversible-action at 8",
        approved: "proposal",
    },
]) {
    test(`${name} admitted as an explore draft gets the same hash, policy decision and approval requirement as under every other source`, async () => {
        const treatments: { readonly source: AdmittedSource; readonly treatment: Treatment }[] = [];
        for (const source of SOURCES) {
            treatments.push({
                source,
                treatment: await treatmentOf(admittedUnder(source, plan())),
            });
        }
        const explore = treatments[0]?.treatment;
        assert.ok(explore !== undefined);
        // The expected treatment, so a test that compared nothing with nothing would fail.
        assert.equal(explore.decision, decision);
        assert.equal(
            explore.withoutApproval,
            "proposal",
            "an explore draft stood approved without an approval",
        );
        assert.equal(explore.withTheSignUpApproval, approved);
        for (const { source, treatment } of treatments) {
            assert.deepEqual(
                treatment,
                explore,
                `${source} was treated differently from explore-draft`,
            );
        }
    });
}
