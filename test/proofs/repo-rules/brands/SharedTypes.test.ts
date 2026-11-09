// The shared types stay as pinned: every error-code union is closed, and every shared type resolves
// to a declaration in core with the shape SharedTypePins.ts holds for it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { compileFiles } from "../support/CompileFiles.ts";

const EXHAUSTIVENESS_FILE = join(
    REPOSITORY_ROOT,
    "test",
    "proofs",
    "repo-rules",
    "composition-root",
    "DescribePlanError.ts",
);
const EXPECTED_ERROR_LINE = /^\s*\/\/\s*@ts-expect-error\b/;
const FORGETFUL_SWITCH_LINE = /^export function describe\w+ForgettingOne\(/;

// ---- Closed error-code unions -------------------------------------------------------------------

test(
    "a switch over each error-code union compiles only when it handles every code",
    { timeout: 300_000 },
    () => {
        const compiled = compileFiles([EXHAUSTIVENESS_FILE]);
        assert.equal(compiled.passed, true, compiled.output);
    },
);

test(
    "removing the expected-error markers makes every switch that forgets a code fail to compile",
    { timeout: 300_000 },
    () => {
        // The mutant: the same file with each @ts-expect-error line deleted. Every switch that leaves a
        // code out must now be a compile error of its own, so the check above can fail.
        const source = readFileSync(EXHAUSTIVENESS_FILE, "utf8");
        const lines = source.split(/\r?\n/);
        const markers = lines.filter((line) => EXPECTED_ERROR_LINE.test(line)).length;
        // One forgetful switch per error-code union, counted from the file so a new union needs no edit here.
        const forgetfulSwitches = lines.filter((line) => FORGETFUL_SWITCH_LINE.test(line)).length;
        assert.ok(forgetfulSwitches >= 6, "the six shared unions each keep a forgetful switch");
        assert.equal(markers, forgetfulSwitches, "one forgetful switch per error-code union");
        const mutant = lines.filter((line) => !EXPECTED_ERROR_LINE.test(line)).join("\n");
        const compiled = compileFiles([
            { name: "error-code-exhaustiveness-mutant.ts", source: mutant },
        ]);
        assert.equal(
            compiled.passed,
            false,
            "the mutant compiled, so a forgotten code would go unnoticed",
        );
        assert.equal(compiled.errors.length, markers, compiled.output);
    },
);

// ---- Every shared type stays as pinned -----------------------------------------------------------

const PINS_FILE = join(
    REPOSITORY_ROOT,
    "test",
    "proofs",
    "repo-rules",
    "brands",
    "SharedTypePins.ts",
);

const pinsWithChange = (from: string, to: string) => {
    const source = readFileSync(PINS_FILE, "utf8");
    assert.ok(source.includes(from), `the pins hold: ${from}`);
    return { name: "shared-type-pins-mutant.ts", source: source.replace(from, to) };
};

test(
    "every shared type resolves to a declaration exported by core, with the shape pinned for it",
    { timeout: 300_000 },
    () => {
        const compiled = compileFiles([PINS_FILE]);
        assert.equal(compiled.passed, true, compiled.output);
    },
);

test(
    "a type name that core does not declare fails the resolution check",
    { timeout: 300_000 },
    () => {
        // The counter-example: one invented name among the real ones must fail, and be named.
        const compiled = compileFiles([
            pinsWithChange("    ActionStep,", "    ActionStep,\n    NoSuchSharedType,"),
        ]);
        assert.equal(compiled.passed, false, "an undeclared name resolved");
        assert.ok(
            compiled.errors.some((line) => line.includes("NoSuchSharedType")),
            compiled.output,
        );
    },
);
