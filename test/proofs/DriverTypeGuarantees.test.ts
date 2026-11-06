// A driver's ports take only resolved steps, and a fill of a secret carries its secret. This is a
// compile-time guarantee: the guarantee file must compile, and each line marked as an expected error
// must be one, so a step still holding a value reference, or a fill without its secret, can never
// reach a driver.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../support/repository.ts";
import { compileFiles } from "./scratch-compiler.ts";

const GUARANTEE_FILE = join(REPOSITORY_ROOT, "test", "proofs", "DriverTypeGuarantees.ts");
const EXPECTED_ERROR_LINE = /^\s*\/\/\s*@ts-expect-error\b/;
const TIMEOUT = 300_000;

const guaranteeLines = (): readonly string[] => readFileSync(GUARANTEE_FILE, "utf8").split(/\r?\n/);

// The guarantee file with the expected-error marker above the line holding `marker` removed.
function withoutMarkerBefore(marker: string): string {
    const lines = guaranteeLines();
    const index = lines.findIndex((line) => line.includes(marker));
    assert.ok(index > 0, `the guarantee file has no line with ${marker}`);
    const above = lines.slice(0, index).findLastIndex((line) => EXPECTED_ERROR_LINE.test(line));
    assert.ok(above >= 0, `no expected-error marker above ${marker}`);
    return lines.toSpliced(above, 1).join("\n");
}

const MUTANTS: readonly (readonly [string, string])[] = [
    ["a plan step to act()", "planStepActs"],
    ["a plan dialog step to act()", "planDialogActs"],
    ["a fill naming a secret it does not carry to act()", "secretReferenceFillActs"],
    ["a secret beside the action to act()", "secretBesideTheAction"],
    ["a plan download step to download()", "planDownloadRuns"],
    ["a plan locator to probe()", "planLocatorIsProbed"],
];

describe("Using the driver guarantee file", () => {
    describe("given it as written", () => {
        describe("when it is type-checked", () => {
            test(
                "then it should compile, so resolved steps and a fill carrying its secret reach a driver",
                { timeout: TIMEOUT },
                () => {
                    const compiled = compileFiles([GUARANTEE_FILE]);
                    assert.equal(compiled.passed, true, compiled.output);
                },
            );
        });

        describe("when its expected-error markers are counted", () => {
            test("then it should hold one for each mutant checked here", () => {
                const markers = guaranteeLines().filter((line) =>
                    EXPECTED_ERROR_LINE.test(line),
                ).length;
                assert.equal(markers, MUTANTS.length);
            });
        });
    });

    for (const [handed, marker] of MUTANTS) {
        describe(`given the line handing ${handed} without its expected-error marker`, () => {
            describe("when it is type-checked", () => {
                test("then it should fail on that line alone", { timeout: TIMEOUT }, () => {
                    const compiled = compileFiles([
                        {
                            name: "DriverTypeGuaranteesMutant.ts",
                            source: withoutMarkerBefore(marker),
                        },
                    ]);
                    assert.equal(
                        compiled.passed,
                        false,
                        `with the marker above ${marker} removed, the file still compiled`,
                    );
                    assert.equal(compiled.errors.length, 1, compiled.output);
                });
            });
        });
    }
});
