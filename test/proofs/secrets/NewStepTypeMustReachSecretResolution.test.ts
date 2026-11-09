// A plan step holding a secret reaches the run unresolved unless secret resolution knows its type.
// So adding a step type has to stop the compiler at secret resolution, the same way it stops at the
// other tables a step type must be listed in. The compiler runs in a copy of the repository holding
// a step type no one has listed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../../support/repository/RepositoryRoot.ts";
import { printedBy } from "../../support/repository/ToolRun.ts";
import { withEdits } from "../repo-rules/support/WithEdits.ts";
import { copyRepository, type ScratchRepository } from "../repo-rules/support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const STEP_TYPES_FILE = "packages/contracts/src/plan/StepType.ts";
const STEPS_FILE = "packages/contracts/src/plan/Plan.ts";
const SECRET_RESOLUTION_FILE = "ResolvePlanSecrets.ts";
const SECRET_RESOLUTION = `packages/engine/src/secrets/${SECRET_RESOLUTION_FILE}`;
const COMPILER = join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc");

const CONFIG_NAME = "tsconfig.secret-resolution.json";

type Compilation = { readonly status: number | null; readonly output: string };

// Compiles secret resolution and what it imports, on the repository's strict settings.
const compileSecretResolution = (root: string): Compilation => {
    writeFileSync(
        join(root, CONFIG_NAME),
        JSON.stringify({
            extends: "./tsconfig.base.json",
            compilerOptions: {
                composite: false,
                declaration: false,
                emitDeclarationOnly: false,
                noEmit: true,
                typeRoots: [join(REPOSITORY_ROOT, "node_modules", "@types").replaceAll("\\", "/")],
            },
            files: [SECRET_RESOLUTION],
        }),
    );
    const compiled = spawnSync(process.execPath, [COMPILER, "--noEmit", "-p", CONFIG_NAME], {
        cwd: root,
        encoding: "utf8",
        timeout: 240_000,
    });
    return { status: compiled.status, output: printedBy(compiled) };
};

const errorsInSecretResolution = ({ output }: Compilation): readonly string[] =>
    output
        .split(/\r?\n/)
        .filter((line) => line.includes(SECRET_RESOLUTION_FILE) && /error TS\d+/.test(line));

describe("Using the compiler on secret resolution", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given the repository as it stands", () => {
        describe("when secret resolution is compiled", () => {
            test("then it should compile", { timeout: TIMEOUT }, () => {
                const compilation = compileSecretResolution(scratch.root());
                assert.equal(compilation.status, 0, compilation.output);
            });
        });
    });

    describe("given a step type holding a secret that secret resolution doesn't list", () => {
        const withStepHoldingASecret = (root: string): Compilation =>
            withEdits(
                root,
                {
                    [STEP_TYPES_FILE]: (text) =>
                        text.replace(
                            'Navigate: "navigate",',
                            'Navigate: "navigate",\n    HoldsSecret: "holdsSecret",',
                        ),
                    [STEPS_FILE]: (text) =>
                        text.replace(
                            "export type Step =",
                            "export type Step =\n  | { readonly type: typeof StepType.HoldsSecret; readonly secret: SecretReference }",
                        ),
                },
                () => compileSecretResolution(root),
            );

        describe("when secret resolution is compiled", () => {
            test("then it should report an error there", { timeout: TIMEOUT }, () => {
                const compilation = withStepHoldingASecret(scratch.root());
                assert.notEqual(compilation.status, 0, compilation.output);
                assert.ok(errorsInSecretResolution(compilation).length > 0, compilation.output);
            });
        });
    });
});
