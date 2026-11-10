// The pins in SharedTypePins.ts are worth having only if a change really fails them, so each kind of
// change is tried on a copy. The working tree is never touched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { compileFiles } from "../support/CompileFiles.ts";

const PINS_FILE = join(
    REPOSITORY_ROOT,
    "test",
    "proofs",
    "repo-rules",
    "brands",
    "SharedTypePins.ts",
);
const COMPILE_TIMEOUT_MILLISECONDS = 300_000;

const SHAPE_CHANGES: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
}[] = [
    {
        name: "a union pinned with one member more",
        from: '"isolated" | "host"',
        to: '"isolated" | "host" | "cloud"',
    },
    {
        name: "a union pinned with one member fewer",
        from: '"not-append-only" | "write-failed"',
        to: '"not-append-only"',
    },
    {
        name: "a field pinned as optional",
        from: "readonly ruleId: string;",
        to: "readonly ruleId?: string;",
    },
    {
        name: "a field pinned as not readonly",
        from: "readonly elementCount: number",
        to: "elementCount: number",
    },
    {
        name: "a port pinned with another method",
        from: '"navigate" | "page"',
        to: '"navigate" | "page" | "reload"',
    },
];

function pinsWithChange(from: string, to: string) {
    const source = readFileSync(PINS_FILE, "utf8");
    assert.ok(source.includes(from), `the pins hold: ${from}`);
    return { name: "SharedTypePinsMutant.ts", source: source.replace(from, to) };
}

describe("Using the shared type pins", () => {
    for (const { name, from, to } of SHAPE_CHANGES) {
        describe(`given ${name} than core declares`, () => {
            describe("when the pins are compiled", () => {
                test(
                    "then it should fail on that one pin",
                    { timeout: COMPILE_TIMEOUT_MILLISECONDS },
                    () => {
                        const compiled = compileFiles([pinsWithChange(from, to)]);
                        assert.equal(compiled.passed, false, "a changed shape still compiled");
                        assert.equal(compiled.errors.length, 1, compiled.output);
                    },
                );
            });
        });
    }
});
