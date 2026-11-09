// A holdout plan is judged on holdouts.json whatever path the caller gives, so that is the file its
// approval is about. Recording the caller's path would let the approval read as being about a file
// nobody checked.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalProof, ApprovalSubject } from "@revisum/engine";
import {
    CODE_OWNERS_PATH,
    HOLDOUTS_PATH,
    HOLDOUT_PLAN_HASH,
    PLAN_PATH,
    withRepository,
    type FixtureRepository,
    type TestRepository,
} from "./examples/MemoryApprovalStore.ts";

const PULL_REQUEST = "12";
const HEAD_COMMIT = "commit-pull-head";

const holdoutNaming = (path: string | undefined): ApprovalSubject => ({
    kind: "holdout-plan",
    hash: HOLDOUT_PLAN_HASH,
    ...(path === undefined ? {} : { path }),
});

const CALLER_PATHS: readonly { readonly name: string; readonly path: string | undefined }[] = [
    { name: "a plan's path", path: PLAN_PATH },
    { name: "an unrelated file's path", path: "docs/guide.md" },
    { name: "holdouts.json", path: HOLDOUTS_PATH },
    { name: "no path", path: undefined },
];

// The change edits holdouts.json, written by someone other than its owner, who reviewed it.
const reviewedHoldoutChange = (fixture: FixtureRepository): void => {
    fixture.protectedFiles[CODE_OWNERS_PATH] =
        `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/holdouts.json @owner-grace\n`;
    const change = fixture.pullRequests[PULL_REQUEST];
    assert.ok(change !== undefined, "the team repository has its pull request");
    change.changedFiles.push({ path: HOLDOUTS_PATH, authors: ["dev-ada"] });
    change.lastCommitTouching[HOLDOUTS_PATH] = HEAD_COMMIT;
};

const verifiedPath = async (
    repository: TestRepository,
    subject: ApprovalSubject,
    proof: ApprovalProof,
): Promise<string | undefined> => {
    const verified = await repository.verify(subject, proof);
    assert.ok(verified.ok, JSON.stringify(verified));
    return verified.value.approval.subject.path;
};

describe("Using the approval verifier", () => {
    for (const { name, path } of CALLER_PATHS) {
        describe(`given a holdout plan's approval whose caller gives ${name}`, () => {
            describe("and its code owner reviewed the change to holdouts.json", () => {
                describe("when the review is verified", () => {
                    test("then it should record holdouts.json as the approval's file", async () => {
                        await withRepository(
                            "team",
                            async (repository) => {
                                assert.equal(
                                    await verifiedPath(
                                        repository,
                                        holdoutNaming(path),
                                        repository.codeOwnerProof("review-grace"),
                                    ),
                                    HOLDOUTS_PATH,
                                );
                            },
                            reviewedHoldoutChange,
                        );
                    });
                });
            });

            describe("and the maintainer's merge is the last commit touching holdouts.json", () => {
                describe("when the lock-down proof is verified", () => {
                    test("then it should record holdouts.json as the approval's file", async () => {
                        await withRepository("solo", async (repository) => {
                            assert.equal(
                                await verifiedPath(
                                    repository,
                                    holdoutNaming(path),
                                    repository.lockdownProof(),
                                ),
                                HOLDOUTS_PATH,
                            );
                        });
                    });
                });
            });
        });
    }

    describe("given a plan's approval", () => {
        describe("when the lock-down proof is verified", () => {
            test("then it should record the plan's own path", async () => {
                await withRepository("solo", async (repository) => {
                    assert.equal(
                        await verifiedPath(
                            repository,
                            repository.subject("plan"),
                            repository.lockdownProof(),
                        ),
                        PLAN_PATH,
                    );
                });
            });
        });
    });
});
