// Code-owner patterns follow GitHub's reading: one star stops at a folder, so "docs/*" owns direct
// children only, while a pattern with no slash that matches a folder, such as "foo*", covers what is
// inside it. And a reviewer's latest verdict, on any commit, decides whether their approval stands.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256, type ApprovalSubject } from "@revisum/engine";
import {
    CODE_OWNERS_PATH,
    eventsOfKind,
    withRepository,
    type FixtureRepository,
    type TestRepository,
} from "../examples/MemoryApprovalStore.ts";
import { ApprovalSubjectKind } from "@revisum/contracts";

const PULL_REQUEST = "12";
const HEAD_COMMIT = "commit-pull-head";

function pullRequestOf(fixture: FixtureRepository) {
    const found = fixture.pullRequests[PULL_REQUEST];
    assert.ok(found !== undefined, "the team repository has its pull request");
    return found;
}

const changeTouches = (fixture: FixtureRepository, path: string, authors: string[]): void => {
    const change = pullRequestOf(fixture);
    change.changedFiles.push({ path, authors });
    change.lastCommitTouching[path] = HEAD_COMMIT;
};

// A refusal whose code the guarantee leaves open: nothing was approved, and the refusal is on record.
function assertRefusedWithAnyCode(
    repository: TestRepository,
    verified: Awaited<ReturnType<TestRepository["verify"]>>,
): void {
    assert.equal(verified.ok, false, `the approval verified: ${JSON.stringify(verified)}`);
    assert.equal(eventsOfKind(repository.events, "plan.approved").length, 0);
    assert.equal(eventsOfKind(repository.events, "approval.refused").length, 1);
}

// Verifies a review of a file the change touches, under the given code-owners file.
const verifyReviewOfFile = async (codeOwners: string, path: string, reviewId: string) => {
    const content = "Reviewed words";
    let refusedOrApproved: { readonly ok: boolean; readonly error?: string } | undefined;
    await withRepository(
        "team",
        async (repository) => {
            const subject: ApprovalSubject = {
                kind: ApprovalSubjectKind.TrustedFile,
                hash: sha256(content),
                path,
            };
            const verified = await repository.verify(subject, repository.codeOwnerProof(reviewId));
            refusedOrApproved = verified.ok ? { ok: true } : { ok: false, error: verified.error };
        },
        (fixture) => {
            fixture.protectedFiles[CODE_OWNERS_PATH] = codeOwners;
            changeTouches(fixture, path, ["dev-ada"]);
            fixture.filesAtCommits = { [HEAD_COMMIT]: { [path]: content } };
        },
    );
    return refusedOrApproved;
};

describe("Using the approval verifier", () => {
    describe("given a code-owners file whose pattern ends in one star", () => {
        const verifyDocsReview = (pattern: string, path: string) =>
            verifyReviewOfFile(`${pattern} @reviewer-linus\n`, path, "review-linus");

        for (const pattern of ["docs/*", "/docs/*"]) {
            describe(`and the pattern is ${pattern}`, () => {
                describe("when the owner reviews a file in a deeper folder", () => {
                    test("then it should refuse with not-code-owner", async () => {
                        assert.deepEqual(await verifyDocsReview(pattern, "docs/deep/guide.md"), {
                            ok: false,
                            error: "not-code-owner",
                        });
                    });
                });

                describe("when the owner reviews a direct child", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(await verifyDocsReview(pattern, "docs/guide.md"), {
                            ok: true,
                        });
                    });
                });
            });
        }

        for (const pattern of ["docs/", "/docs/", "docs/**"]) {
            describe(`and the pattern is ${pattern}, which covers a whole folder`, () => {
                describe("when the owner reviews a file in a deeper folder", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(await verifyDocsReview(pattern, "docs/deep/guide.md"), {
                            ok: true,
                        });
                    });
                });
            });
        }
    });

    describe("given a catch-all code owner and a later pattern with no slash that ends in one star", () => {
        const catchAllThenStar = "* @owner-grace\nfoo* @reviewer-linus\n";

        for (const path of ["foobar/x", "foobar/deep/x", "src/foobar/x"]) {
            describe(`and the change touches ${path}, inside a folder the later pattern matches`, () => {
                describe("when the later pattern's owner reviews it", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(catchAllThenStar, path, "review-linus"),
                            { ok: true },
                        );
                    });
                });

                describe("when only the catch-all's owner reviews it", () => {
                    test("then it should refuse with not-code-owner", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(catchAllThenStar, path, "review-grace"),
                            { ok: false, error: "not-code-owner" },
                        );
                    });
                });
            });
        }

        describe("and the change touches a file the later pattern matches by name", () => {
            describe("when the later pattern's owner reviews it", () => {
                test("then it should approve", async () => {
                    assert.deepEqual(
                        await verifyReviewOfFile(catchAllThenStar, "foobar", "review-linus"),
                        { ok: true },
                    );
                });
            });
        });

        describe("and the change touches a folder the later pattern does not match", () => {
            describe("when the catch-all's owner reviews it", () => {
                test("then it should approve", async () => {
                    assert.deepEqual(
                        await verifyReviewOfFile(catchAllThenStar, "other/x", "review-grace"),
                        { ok: true },
                    );
                });
            });
        });
    });

    describe("given a code owner's approval of the last commit", () => {
        const laterReview = (
            login: string,
            commit: string,
            state: "approved" | "changes-requested" | "commented",
            id = "review-later",
        ) => ({
            id,
            state,
            commit,
            reviewer: { login, type: "user" as const },
            submittedAt: "2026-10-20T15:30:00Z",
        });

        for (const login of ["owner-grace", "Owner-Grace"]) {
            describe(`and ${login} later requested changes on that commit`, () => {
                describe("when the approval is offered as proof", () => {
                    test("then it should refuse the approval", async () => {
                        await withRepository(
                            "team",
                            async (repository) => {
                                const verified = await repository.verify(
                                    repository.subject("plan"),
                                    repository.codeOwnerProof("review-grace"),
                                );
                                assertRefusedWithAnyCode(repository, verified);
                            },
                            (fixture) => {
                                pullRequestOf(fixture).reviews.push(
                                    laterReview(login, HEAD_COMMIT, "changes-requested"),
                                );
                            },
                        );
                    });
                });
            });
        }

        describe("and another reviewer later requested changes on that commit", () => {
            describe("when the approval is offered as proof", () => {
                test("then it should still approve", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("plan"),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                        },
                        (fixture) => {
                            pullRequestOf(fixture).reviews.push(
                                laterReview("reviewer-linus", HEAD_COMMIT, "changes-requested"),
                            );
                        },
                    );
                });
            });
        });

        // The change moved on after the approval, in a commit that leaves the plan alone: the approved
        // commit is still the last one to touch the plan.
        const newerCommit = "commit-pull-newer";
        const movedOnWithoutThePlan = (
            fixture: FixtureRepository,
            ...reviews: readonly ReturnType<typeof laterReview>[]
        ): void => {
            const change = pullRequestOf(fixture);
            change.headCommit = newerCommit;
            change.reviews.push(...reviews);
        };
        const assertStillApproves = async (
            edit: (fixture: FixtureRepository) => void,
        ): Promise<void> => {
            await withRepository(
                "team",
                async (repository) => {
                    const verified = await repository.verify(
                        repository.subject("plan"),
                        repository.codeOwnerProof("review-grace"),
                    );
                    assert.equal(verified.ok, true, JSON.stringify(verified));
                },
                edit,
            );
        };

        for (const login of ["owner-grace", "Owner-Grace"]) {
            describe(`and ${login} later requested changes on a newer commit that leaves the plan alone`, () => {
                describe("when the approval is offered as proof", () => {
                    test("then it should refuse the approval", async () => {
                        await withRepository(
                            "team",
                            async (repository) => {
                                const verified = await repository.verify(
                                    repository.subject("plan"),
                                    repository.codeOwnerProof("review-grace"),
                                );
                                assertRefusedWithAnyCode(repository, verified);
                            },
                            (fixture) => {
                                movedOnWithoutThePlan(
                                    fixture,
                                    laterReview(login, newerCommit, "changes-requested"),
                                );
                            },
                        );
                    });
                });
            });
        }

        describe("and another reviewer later requested changes on a newer commit that leaves the plan alone", () => {
            describe("when the approval is offered as proof", () => {
                test("then it should still approve", async () => {
                    await assertStillApproves((fixture) => {
                        movedOnWithoutThePlan(
                            fixture,
                            laterReview("reviewer-linus", newerCommit, "changes-requested"),
                        );
                    });
                });
            });
        });

        describe("and the reviewer only commented on a newer commit that leaves the plan alone", () => {
            describe("when the approval is offered as proof", () => {
                test("then it should still approve", async () => {
                    await assertStillApproves((fixture) => {
                        movedOnWithoutThePlan(
                            fixture,
                            laterReview("owner-grace", newerCommit, "commented"),
                        );
                    });
                });
            });
        });

        describe("and the reviewer requested changes on a newer commit and then approved it", () => {
            describe("when the earlier approval is offered as proof", () => {
                test("then it should still approve", async () => {
                    await assertStillApproves((fixture) => {
                        movedOnWithoutThePlan(
                            fixture,
                            laterReview("owner-grace", newerCommit, "changes-requested"),
                            {
                                ...laterReview(
                                    "owner-grace",
                                    newerCommit,
                                    "approved",
                                    "review-again",
                                ),
                                submittedAt: "2026-10-20T16:30:00Z",
                            },
                        );
                    });
                });
            });
        });

        describe("and the reviewer earlier requested changes on an older commit", () => {
            describe("when the approval is offered as proof", () => {
                test("then it should still approve", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("plan"),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                        },
                        (fixture) => {
                            pullRequestOf(fixture).reviews.unshift({
                                ...laterReview(
                                    "owner-grace",
                                    "commit-pull-first",
                                    "changes-requested",
                                ),
                                submittedAt: "2026-10-20T09:30:00Z",
                            });
                        },
                    );
                });
            });
        });

        describe("and the reviewer requested changes and then approved the same commit again", () => {
            describe("when the newer approval is offered as proof", () => {
                test("then it should approve", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("plan"),
                                repository.codeOwnerProof("review-again"),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                        },
                        (fixture) => {
                            pullRequestOf(fixture).reviews.push(
                                laterReview("owner-grace", HEAD_COMMIT, "changes-requested"),
                                {
                                    ...laterReview(
                                        "owner-grace",
                                        HEAD_COMMIT,
                                        "approved",
                                        "review-again",
                                    ),
                                    submittedAt: "2026-10-20T16:30:00Z",
                                },
                            );
                        },
                    );
                });
            });
        });
    });
});
