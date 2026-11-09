import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findFolderDirectionProblems } from "../../../../../tools/repo-rules/code/CheckImportCycles.ts";

const PROJECT_FILE = "packages/engine/src/project/ParseProject.ts";
const PLAN_FILE = "packages/engine/src/plan/ParsePlan.ts";
const SHARED_FILE = "packages/engine/src/decoding/ReadRecord.ts";

const importing = (target: string, isTypeOnly = false) => [{ target, isTypeOnly }];

describe("Using the folder direction check", () => {
    describe("given a project file that imports a plan file", () => {
        describe("when the check runs", () => {
            test("then it should report the file and what it imports", () => {
                const problems = findFolderDirectionProblems(
                    new Map([[PROJECT_FILE, importing(PLAN_FILE)]]),
                );

                assert.equal(problems.length, 1);
                assert.match(problems[0] ?? "", new RegExp(`${PROJECT_FILE} imports ${PLAN_FILE}`));
            });
        });
    });

    describe("given a project file whose import of a plan file is type-only", () => {
        describe("when the check runs", () => {
            test("then it should still report it, since the folders still depend both ways", () => {
                const problems = findFolderDirectionProblems(
                    new Map([[PROJECT_FILE, importing(PLAN_FILE, true)]]),
                );

                assert.equal(problems.length, 1);
            });
        });
    });

    describe("given a plan file that imports a project file", () => {
        describe("when the check runs", () => {
            test("then it should pass, since that is the allowed direction", () => {
                const problems = findFolderDirectionProblems(
                    new Map([[PLAN_FILE, importing(PROJECT_FILE)]]),
                );

                assert.deepEqual(problems, []);
            });
        });
    });

    describe("given a project file that imports from below both folders", () => {
        describe("when the check runs", () => {
            test("then it should pass", () => {
                const problems = findFolderDirectionProblems(
                    new Map([[PROJECT_FILE, importing(SHARED_FILE)]]),
                );

                assert.deepEqual(problems, []);
            });
        });
    });
});
