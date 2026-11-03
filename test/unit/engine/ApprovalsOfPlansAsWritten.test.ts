// A plan's hash is over the plan as the parser returns it, and a person's file holds the plan as they
// wrote it: as readable text, or as JSON with a URL the parser tidies. Both are the same plan, so the
// maintainer who landed the file approves it. A file holding anything else is still no approval.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    canonicalJson,
    planHash,
    planParser,
    sha256,
    writePlanText,
    type ApprovalSubject,
    type Plan,
} from "@revisum/engine";
import {
    PLAN_PATH,
    eventsOfKind,
    readFixture,
    withRepository,
    type TestRepository,
} from "./approval-repositories.ts";
import { signupPlan, withValue, type JsonRecord } from "./plan-examples.ts";

const READABLE_PLAN_PATH = "plans/signup.plan";

// The URL of the plan's first step, written with a dot segment the parser resolves.
const UNTIDY_URL = "/./signup.html";

const parsedInRepository = async (repository: TestRepository, raw: unknown): Promise<Plan> => {
    const parsed = planParser(await repository.trustedProject())(raw);
    assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
    return parsed.value;
};

const planSubject = (plan: Plan, path: string): ApprovalSubject => ({
    kind: "plan",
    hash: planHash(plan),
    path,
});

const landedFile =
    (path: string, content: string) =>
    (fixture: ReturnType<typeof readFixture>): void => {
        fixture.protectedFiles[path] = content;
    };

const untidyPlan = (): JsonRecord => withValue(signupPlan(), ["steps", 0, "url"], UNTIDY_URL);

const verifiedSubject = async (
    repository: TestRepository,
    subject: ApprovalSubject,
): Promise<string> => {
    const verified = await repository.verify(subject, repository.lockdownProof());
    return verified.ok ? "approved" : verified.error;
};

describe("Using the approval verifier", () => {
    describe("given a plan the maintainer landed as readable text", () => {
        describe("when the plan's hash is verified against the file", () => {
            test("then it should approve the plan", async () => {
                const { text, hash } = await readablePlan();
                await withRepository(
                    "solo",
                    async (repository) => {
                        const subject: ApprovalSubject = {
                            kind: "plan",
                            hash,
                            path: READABLE_PLAN_PATH,
                        };
                        assert.equal(await verifiedSubject(repository, subject), "approved");
                        assert.equal(eventsOfKind(repository.events, "plan.approved").length, 1);
                    },
                    landedFile(READABLE_PLAN_PATH, text),
                );
            });
        });

        describe("when the hash of another plan is verified against the file", () => {
            test("then it should refuse it with not-protected-branch", async () => {
                const { text } = await readablePlan();
                await withRepository(
                    "solo",
                    async (repository) => {
                        const other = await parsedInRepository(
                            repository,
                            withValue(signupPlan(), ["meta", "title"], "Another plan"),
                        );
                        assert.equal(
                            await verifiedSubject(
                                repository,
                                planSubject(other, READABLE_PLAN_PATH),
                            ),
                            "not-protected-branch",
                        );
                    },
                    landedFile(READABLE_PLAN_PATH, text),
                );
            });
        });
    });

    describe("given a JSON plan the maintainer landed with a URL the parser tidies", () => {
        describe("when the hash of the plan as parsed is verified against the file", () => {
            test("then it should approve the plan", async () => {
                await withRepository(
                    "solo",
                    async (repository) => {
                        const plan = await parsedInRepository(repository, untidyPlan());
                        assert.notEqual(
                            planHash(plan),
                            sha256(canonicalJson(untidyPlan())),
                            "the parser left the plan as written, so this proves nothing",
                        );
                        assert.equal(
                            await verifiedSubject(repository, planSubject(plan, PLAN_PATH)),
                            "approved",
                        );
                    },
                    landedFile(PLAN_PATH, JSON.stringify(untidyPlan(), null, 2)),
                );
            });
        });
    });

    describe("given a file on the protected branch that is no plan", () => {
        describe("when a plan's hash is verified against it", () => {
            test("then it should refuse it with not-protected-branch", async () => {
                await withRepository(
                    "solo",
                    async (repository) => {
                        const plan = await parsedInRepository(repository, signupPlan());
                        assert.equal(
                            await verifiedSubject(
                                repository,
                                planSubject(plan, READABLE_PLAN_PATH),
                            ),
                            "not-protected-branch",
                        );
                    },
                    landedFile(READABLE_PLAN_PATH, "Not a plan at all\n"),
                );
            });
        });
    });
});

// The sign-up plan as a person's readable file holds it, with the hash of the plan it reads as.
async function readablePlan(): Promise<{ readonly text: string; readonly hash: string }> {
    let found: { readonly text: string; readonly hash: string } | undefined;
    await withRepository("solo", async (repository) => {
        const plan = await parsedInRepository(repository, signupPlan());
        found = { text: writePlanText(plan), hash: planHash(plan) };
    });
    return found ?? assert.fail("the plan was not written");
}
