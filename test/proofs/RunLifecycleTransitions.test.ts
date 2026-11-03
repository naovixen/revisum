// Every transition the lifecycle table allows is one a run can take. A run goes from Resolved straight
// to Running, so nothing can end it Errored from Resolved. No run can show that, because no run gets
// there: the table is a compile-time guarantee, so this is a compile-time test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compileFiles } from "./scratch-compiler.ts";

const TIMEOUT = 300_000;

const compileTransition = (from: string, to: string) =>
    compileFiles([
        {
            name: "lifecycle-transition.ts",
            source: `import { lifecycle } from "@revisum/engine";\nlifecycle.transition("${from}", "${to}");\n`,
        },
    ]);

describe("Using the run lifecycle table", () => {
    describe("given a transition from Resolved to Errored", () => {
        describe("when it is compiled", () => {
            test("then it should not type-check", { timeout: TIMEOUT }, () => {
                const compiled = compileTransition("Resolved", "Errored");
                assert.equal(compiled.passed, false, "the table still allows the transition");
                assert.equal(compiled.errors.length, 1, compiled.output);
            });
        });
    });

    describe("given a transition from Resolved to Running", () => {
        describe("when it is compiled", () => {
            test("then it should type-check", { timeout: TIMEOUT }, () => {
                const compiled = compileTransition("Resolved", "Running");
                assert.equal(compiled.passed, true, compiled.output);
            });
        });
    });

    describe("given a transition from Running to Errored", () => {
        describe("when it is compiled", () => {
            test("then it should type-check", { timeout: TIMEOUT }, () => {
                const compiled = compileTransition("Running", "Errored");
                assert.equal(compiled.passed, true, compiled.output);
            });
        });
    });
});
