import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkDependencyReviews } from "../../../tools/check-dependency-reviews.ts";

// A workspace with one package and no third-party dependencies, so a well-formed lock file has
// nothing on the trust path to review.
const WORKSPACE_MANIFEST = { name: "@revisum/engine", version: "0.0.0" };

// The problems the check finds with this lock file, given no reviews; a check that throws counts as
// failing, with its message as the problem.
function problemsWith(lock: unknown): readonly string[] {
    const root = mkdtempSync(join(tmpdir(), "dependency-reviews-"));
    try {
        mkdirSync(join(root, "packages", "engine"), { recursive: true });
        writeFileSync(
            join(root, "packages", "engine", "package.json"),
            JSON.stringify(WORKSPACE_MANIFEST),
        );
        writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
        try {
            return checkDependencyReviews(root, []);
        } catch (error) {
            return [String(error)];
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe("Using the dependency review check", () => {
    describe("given a lock file that lists its installed packages", () => {
        describe("when none of them is third-party", () => {
            test("then it should pass", () => {
                const lock = {
                    lockfileVersion: 3,
                    packages: { "": { name: "revisum" }, "packages/engine": WORKSPACE_MANIFEST },
                };
                assert.deepEqual(problemsWith(lock), []);
            });
        });
    });

    describe("given a lock file with no packages field", () => {
        describe("when the check runs", () => {
            test("then it should fail, not pass with an empty trust path", () => {
                assert.notDeepEqual(problemsWith({ lockfileVersion: 3 }), []);
            });
        });
    });

    for (const [shape, packages] of [
        ["a list", [WORKSPACE_MANIFEST]],
        ["a string", "packages/engine"],
        ["null", null],
    ] as const) {
        describe(`given a lock file whose packages field is ${shape}`, () => {
            describe("when the check runs", () => {
                test("then it should fail, not pass with an empty trust path", () => {
                    assert.notDeepEqual(problemsWith({ lockfileVersion: 3, packages }), []);
                });
            });
        });
    }

    describe("given a lock file that is not an object", () => {
        describe("when the check runs", () => {
            test("then it should fail, not pass with an empty trust path", () => {
                assert.notDeepEqual(problemsWith([]), []);
            });
        });
    });
});
