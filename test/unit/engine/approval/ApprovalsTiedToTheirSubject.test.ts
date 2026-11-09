// An approval must be about the subject it names. On the lock-down route the proof's commit must be
// the last one touching the subject on the protected branch. On the code-owner route a holdout plan
// is judged on holdouts.json whatever path the caller gives. On both, a plan lives under plans/.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planHash, type ApprovalSubject } from "@revisum/engine";
import {
    CODE_OWNERS_PATH,
    HOLDOUTS_PATH,
    HOLDOUT_PLAN_HASH,
    PLAN_PATH,
    assertRefused,
    eventsOfKind,
    parsedSignupPlan,
    withRepository,
    type FixtureRepository,
    type TestRepository,
} from "./examples/MemoryApprovalStore.ts";

const MAINTAINER = "maintainer-mia";
const PULL_REQUEST = "12";
const HEAD_COMMIT = "commit-pull-head";
const OLDER_MAINTAINER_COMMIT = "commit-older-maintainer";
const BOT_COMMIT = "commit-bot-landed";

function pullRequestOf(fixture: FixtureRepository) {
    const found = fixture.pullRequests[PULL_REQUEST];
    assert.ok(found !== undefined, "the team repository has its pull request");
    return found;
}

// The change also edits `path`, written by `authors`, last touched by `lastCommit`.
const changeTouches = (
    fixture: FixtureRepository,
    path: string,
    authors: string[],
    lastCommit = HEAD_COMMIT,
): void => {
    const change = pullRequestOf(fixture);
    change.changedFiles.push({ path, authors });
    change.lastCommitTouching[path] = lastCommit;
};

const landed = (
    fixture: FixtureRepository,
    commit: string,
    login: string,
    isBot: boolean,
): void => {
    fixture.landings.push({
        commit,
        branch: fixture.protectedBranch,
        login,
        type: isBot ? "bot" : "user",
        at: "2026-10-23T09:00:00Z",
    });
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

const holdoutAt = (path: string): ApprovalSubject => ({
    kind: "holdout-plan",
    hash: HOLDOUT_PLAN_HASH,
    path,
});
const planAt = (path: string): ApprovalSubject => ({
    kind: "plan",
    hash: planHash(parsedSignupPlan()),
    path,
});

// The team repository, with holdouts.json owned by the plans' owner.
const holdoutsOwned = (fixture: FixtureRepository): void => {
    fixture.protectedFiles[CODE_OWNERS_PATH] =
        `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/holdouts.json @owner-grace\n`;
};

describe("Using the approval verifier", () => {
    describe("given a lock-down proof naming an older commit the maintainer landed", () => {
        const olderCommitThenBot = (fixture: FixtureRepository, subjectPath: string): void => {
            landed(fixture, OLDER_MAINTAINER_COMMIT, MAINTAINER, false);
            landed(fixture, BOT_COMMIT, "release-helper[bot]", true);
            fixture.lastCommitsOnProtectedBranch = { [subjectPath]: BOT_COMMIT };
        };

        describe("and a bot landed the last commit touching the plan", () => {
            describe("when the proof is verified", () => {
                test("then it should refuse the approval", async () => {
                    await withRepository(
                        "solo",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("plan"),
                                repository.lockdownProof({ commit: OLDER_MAINTAINER_COMMIT }),
                            );
                            assertRefusedWithAnyCode(repository, verified);
                        },
                        (fixture) => {
                            olderCommitThenBot(fixture, PLAN_PATH);
                        },
                    );
                });
            });
        });

        describe("and a bot landed the last commit touching holdouts.json", () => {
            describe("when a proof for a holdout plan is verified", () => {
                test("then it should refuse the approval", async () => {
                    await withRepository(
                        "solo",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("holdout-plan"),
                                repository.lockdownProof({ commit: OLDER_MAINTAINER_COMMIT }),
                            );
                            assertRefusedWithAnyCode(repository, verified);
                        },
                        (fixture) => {
                            olderCommitThenBot(fixture, HOLDOUTS_PATH);
                        },
                    );
                });
            });
        });
    });

    describe("given a lock-down proof naming the last commit touching the plan", () => {
        describe("and a bot landed a later commit that touched only other files", () => {
            describe("when the proof is verified", () => {
                test("then it should approve as declared", async () => {
                    const planCommit = "commit-plan-merge";
                    await withRepository(
                        "solo",
                        async (repository) => {
                            const verified = await repository.verify(
                                repository.subject("plan"),
                                repository.lockdownProof({ commit: planCommit }),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                            assert.equal(
                                verified.value.approval.strength,
                                "declared",
                            );
                        },
                        (fixture) => {
                            landed(fixture, planCommit, MAINTAINER, false);
                            landed(fixture, "commit-bot-head", "release-helper[bot]", true);
                            fixture.protectedCommit = "commit-bot-head";
                            fixture.lastCommitsOnProtectedBranch = { [PLAN_PATH]: planCommit };
                        },
                    );
                });
            });
        });
    });

    describe("given a holdout approval whose caller names another file", () => {
        describe("and the reviewer owns that file but not holdouts.json", () => {
            describe("when the review is verified", () => {
                test("then it should refuse with not-code-owner", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                holdoutAt("docs/guide.md"),
                                repository.codeOwnerProof("review-linus"),
                            );
                            assertRefused(repository, verified, "not-code-owner");
                        },
                        (fixture) => {
                            holdoutsOwned(fixture);
                            changeTouches(fixture, "docs/guide.md", ["dev-ada"]);
                            changeTouches(fixture, HOLDOUTS_PATH, ["dev-ada"]);
                        },
                    );
                });
            });
        });

        describe("and the reviewer wrote the change to holdouts.json", () => {
            describe("when the review is verified", () => {
                test("then it should refuse with self-approval", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                holdoutAt(PLAN_PATH),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assertRefused(repository, verified, "self-approval");
                        },
                        (fixture) => {
                            holdoutsOwned(fixture);
                            changeTouches(fixture, HOLDOUTS_PATH, ["owner-grace"]);
                        },
                    );
                });
            });
        });

        describe("and holdouts.json changed after the reviewed commit", () => {
            describe("when the review is verified", () => {
                test("then it should refuse with stale-commit", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                holdoutAt(PLAN_PATH),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assertRefused(repository, verified, "stale-commit");
                        },
                        (fixture) => {
                            holdoutsOwned(fixture);
                            changeTouches(fixture, HOLDOUTS_PATH, ["dev-ada"], "commit-pull-newer");
                        },
                    );
                });
            });
        });

        describe("and the change does not touch holdouts.json", () => {
            describe("when the review is verified", () => {
                test("then it should refuse with subject-mismatch", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                holdoutAt(PLAN_PATH),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assertRefused(repository, verified, "subject-mismatch");
                        },
                        (fixture) => {
                            holdoutsOwned(fixture);
                        },
                    );
                });
            });
        });
    });

    describe("given a holdout approval naming holdouts.json", () => {
        describe("and its owner reviewed the last commit someone else wrote", () => {
            describe("when the review is verified", () => {
                test("then it should approve as verified", async () => {
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                holdoutAt(HOLDOUTS_PATH),
                                repository.codeOwnerProof("review-grace"),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                        },
                        (fixture) => {
                            holdoutsOwned(fixture);
                            changeTouches(fixture, HOLDOUTS_PATH, ["dev-ada"]);
                        },
                    );
                });
            });
        });
    });

    describe("given a plan subject outside plans/", () => {
        describe("and the reviewer owns the folder it is in", () => {
            describe("when the review is verified", () => {
                test("then it should refuse with subject-mismatch", async () => {
                    const path = "docs/signup.json";
                    await withRepository(
                        "team",
                        async (repository) => {
                            const verified = await repository.verify(
                                planAt(path),
                                repository.codeOwnerProof("review-linus"),
                            );
                            assertRefused(repository, verified, "subject-mismatch");
                        },
                        (fixture) => {
                            changeTouches(fixture, path, ["dev-ada"]);
                            fixture.filesAtCommits = {
                                [HEAD_COMMIT]: { [path]: parsedSignupPlan() },
                            };
                        },
                    );
                });
            });
        });

        for (const path of ["docs/signup.json", "plans/../docs/signup.json"]) {
            describe(`and the maintainer landed it at ${path}`, () => {
                describe("when the lock-down proof is verified", () => {
                    test("then it should refuse with subject-mismatch", async () => {
                        await withRepository(
                            "solo",
                            async (repository) => {
                                const verified = await repository.verify(
                                    planAt(path),
                                    repository.lockdownProof(),
                                );
                                assertRefused(repository, verified, "subject-mismatch");
                            },
                            (fixture) => {
                                fixture.protectedFiles[path] = parsedSignupPlan();
                            },
                        );
                    });
                });
            });
        }
    });

    describe("given a plan subject in a folder inside plans/", () => {
        describe("and the maintainer landed it", () => {
            describe("when the lock-down proof is verified", () => {
                test("then it should approve as declared", async () => {
                    const path = "plans/team/signup.json";
                    await withRepository(
                        "solo",
                        async (repository) => {
                            const verified = await repository.verify(
                                planAt(path),
                                repository.lockdownProof(),
                            );
                            assert.equal(verified.ok, true, JSON.stringify(verified));
                        },
                        (fixture) => {
                            fixture.protectedFiles[path] = parsedSignupPlan();
                        },
                    );
                });
            });
        });
    });
});
