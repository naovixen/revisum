// An anchored pattern whose last segment is only partly a star, such as "src/foo*", can name a folder
// and so covers what is inside it. A last segment that is nothing but a star, such as "docs/*", stops
// at direct children, as on GitHub.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256, type ApprovalSubject } from "@revisum/engine";
import {
    CODE_OWNERS_PATH,
    withRepository,
    type FixtureRepository,
} from "../examples/MemoryApprovalStore.ts";
import { ApprovalSubjectKind } from "@revisum/contracts";

const PULL_REQUEST = "12";
const HEAD_COMMIT = "commit-pull-head";

function pullRequestOf(fixture: FixtureRepository) {
    const found = fixture.pullRequests[PULL_REQUEST];
    assert.ok(found !== undefined, "the team repository has its pull request");
    return found;
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
            const change = pullRequestOf(fixture);
            change.changedFiles.push({ path, authors: ["dev-ada"] });
            change.lastCommitTouching[path] = HEAD_COMMIT;
            fixture.filesAtCommits = { [HEAD_COMMIT]: { [path]: content } };
        },
    );
    return refusedOrApproved;
};

const NOT_CODE_OWNER = { ok: false, error: "not-code-owner" };
const APPROVED = { ok: true };

const catchAllThen = (pattern: string): string => `* @owner-grace\n${pattern} @reviewer-linus\n`;

describe("Using the approval verifier", () => {
    for (const { pattern, insideFolder, deeperInFolder, fileByName } of [
        {
            pattern: "src/foo*",
            insideFolder: "src/foobar/x.json",
            deeperInFolder: "src/foobar/deep/x.json",
            fileByName: "src/foobar.json",
        },
        {
            pattern: "/foo*",
            insideFolder: "foobar/x.json",
            deeperInFolder: "foobar/deep/x.json",
            fileByName: "foobar.json",
        },
    ]) {
        describe(`given a catch-all code owner and a later anchored pattern ${pattern}`, () => {
            for (const path of [insideFolder, deeperInFolder]) {
                describe(`and the change touches ${path}, inside a folder the pattern matches`, () => {
                    describe("when the later pattern's owner reviews it", () => {
                        test("then it should approve", async () => {
                            assert.deepEqual(
                                await verifyReviewOfFile(
                                    catchAllThen(pattern),
                                    path,
                                    "review-linus",
                                ),
                                APPROVED,
                            );
                        });
                    });

                    describe("when only the catch-all's owner reviews it", () => {
                        test("then it should refuse with not-code-owner", async () => {
                            assert.deepEqual(
                                await verifyReviewOfFile(
                                    catchAllThen(pattern),
                                    path,
                                    "review-grace",
                                ),
                                NOT_CODE_OWNER,
                            );
                        });
                    });
                });
            }

            describe(`and the change touches ${fileByName}, which the pattern matches by name`, () => {
                describe("when the later pattern's owner reviews it", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(
                                catchAllThen(pattern),
                                fileByName,
                                "review-linus",
                            ),
                            APPROVED,
                        );
                    });
                });
            });
        });
    }

    describe("given a catch-all code owner and a later pattern anchored at the root by /foo*", () => {
        describe("and the change touches a matching folder below the root", () => {
            describe("when the catch-all's owner reviews it", () => {
                test("then it should approve, since the anchored pattern does not reach it", async () => {
                    assert.deepEqual(
                        await verifyReviewOfFile(
                            catchAllThen("/foo*"),
                            "src/foobar/x.json",
                            "review-grace",
                        ),
                        APPROVED,
                    );
                });
            });
        });
    });

    for (const { pattern, deeperPath, directChild } of [
        {
            pattern: "src/docs/*",
            deeperPath: "src/docs/deep/x.json",
            directChild: "src/docs/x.json",
        },
        { pattern: "/*", deeperPath: "docs/x.json", directChild: "x.json" },
    ]) {
        describe(`given a catch-all code owner and a later pattern ${pattern}, whose last segment is only a star`, () => {
            describe(`and the change touches ${deeperPath}, below the direct children`, () => {
                describe("when the later pattern's owner reviews it", () => {
                    test("then it should refuse with not-code-owner", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(
                                catchAllThen(pattern),
                                deeperPath,
                                "review-linus",
                            ),
                            NOT_CODE_OWNER,
                        );
                    });
                });

                describe("when the catch-all's owner reviews it", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(
                                catchAllThen(pattern),
                                deeperPath,
                                "review-grace",
                            ),
                            APPROVED,
                        );
                    });
                });
            });

            describe(`and the change touches ${directChild}, a direct child`, () => {
                describe("when the later pattern's owner reviews it", () => {
                    test("then it should approve", async () => {
                        assert.deepEqual(
                            await verifyReviewOfFile(
                                catchAllThen(pattern),
                                directChild,
                                "review-linus",
                            ),
                            APPROVED,
                        );
                    });
                });
            });
        });
    }
});
