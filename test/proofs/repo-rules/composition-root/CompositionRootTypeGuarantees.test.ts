// What the composition root hands out cannot be misused: a launcher with its own flags, a login moved
// to another session, a redactor among a port's needs. This is a compile-time guarantee, so the
// guarantee file must compile, each line marked as an expected error being one.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { compileFiles } from "../support/CompileFiles.ts";

const GUARANTEE_FILE = join(
    REPOSITORY_ROOT,
    "test",
    "proofs",
    "repo-rules",
    "composition-root",
    "CompositionRootTypeGuarantees.ts",
);
const TIMEOUT = 300_000;

describe("Using the composition root guarantee file", () => {
    describe("given it as written", () => {
        describe("when it is type-checked", () => {
            test(
                "then it should compile, so every misuse it names stays an error",
                { timeout: TIMEOUT },
                () => {
                    const compiled = compileFiles([GUARANTEE_FILE]);
                    assert.equal(compiled.passed, true, compiled.output);
                },
            );
        });
    });
});
