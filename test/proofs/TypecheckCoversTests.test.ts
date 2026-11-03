// `npm run typecheck` has to reach the test set, so a type error in a test fails the fast checks
// rather than waiting for the proofs. The build is run for real in a small folder that holds the
// root build config narrowed to the test set's project, because a copy of the whole repository
// builds every package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../support/repository.ts";
import { withEdits } from "./scratch-edits.ts";

const TIMEOUT = 300_000;
const ROOT_CONFIG = "tsconfig.json";
const TEST_CONFIG = join("test", "tsconfig.json");
const PLANTED_FILE = "planted-type-check.test.ts";
const PLANTED_PATH = `test/${PLANTED_FILE}`;

type RootConfig = {
    readonly files: readonly string[];
    readonly references: readonly { readonly path: string }[];
};

const readRootConfig = (): RootConfig =>
    JSON.parse(readFileSync(join(REPOSITORY_ROOT, ROOT_CONFIG), "utf8")) as RootConfig;

// "test", "./test" and "test/tsconfig.json" are the same project to the compiler.
const isTestSetProject = (path: string): boolean =>
    path.replace(/^\.\//, "").replace(/\/tsconfig\.json$/, "") === "test";

const runTypecheck = (cwd: string): { readonly status: number | null; readonly output: string } => {
    const ran = spawnSync("npm run typecheck", {
        cwd,
        encoding: "utf8",
        shell: true,
        timeout: 240_000,
    });
    return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
};

describe("Using the typecheck script", () => {
    describe("given the repository as it stands", () => {
        describe("when the root build config is read", () => {
            test("then it should have the test set's project in the build", () => {
                const references = readRootConfig().references.map((reference) => reference.path);
                assert.ok(
                    references.some(isTestSetProject),
                    `the references are ${references.join(", ")}`,
                );
            });
        });

        describe("when the script is read", () => {
            test("then it should build every project the root build config references", () => {
                const manifest = JSON.parse(
                    readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"),
                ) as { readonly scripts: Readonly<Record<string, string>> };
                assert.equal(manifest.scripts["typecheck"], "tsc --build");
            });
        });
    });

    describe("given the build narrowed to the test set's project", () => {
        let folder: string;
        before(() => {
            folder = mkdtempSync(join(tmpdir(), "typecheck-"));
            copyFileSync(join(REPOSITORY_ROOT, "package.json"), join(folder, "package.json"));
            copyFileSync(
                join(REPOSITORY_ROOT, "tsconfig.base.json"),
                join(folder, "tsconfig.base.json"),
            );
            mkdirSync(join(folder, "test"));
            copyFileSync(join(REPOSITORY_ROOT, TEST_CONFIG), join(folder, TEST_CONFIG));
            const rootConfig = readRootConfig();
            writeFileSync(
                join(folder, ROOT_CONFIG),
                JSON.stringify({
                    ...rootConfig,
                    references: rootConfig.references.filter((reference) =>
                        isTestSetProject(reference.path),
                    ),
                }),
            );
            symlinkSync(
                join(REPOSITORY_ROOT, "node_modules"),
                join(folder, "node_modules"),
                "junction",
            );
        });
        after(() => {
            // Remove the link first, so deleting the folder can never reach the real node_modules.
            unlinkSync(join(folder, "node_modules"));
            rmSync(folder, { recursive: true, force: true });
        });

        describe("when a test has a type error", () => {
            test("then it should fail, naming the test", { timeout: TIMEOUT }, () => {
                const run = withEdits(
                    folder,
                    { [PLANTED_PATH]: 'export const wrong: number = "text";\n' },
                    () => runTypecheck(folder),
                );
                assert.notEqual(run.status, 0, run.output);
                assert.ok(run.output.includes(PLANTED_FILE), run.output);
            });
        });

        describe("when every test type-checks", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const run = withEdits(
                    folder,
                    { [PLANTED_PATH]: "export const right: number = 1;\n" },
                    () => runTypecheck(folder),
                );
                assert.equal(run.status, 0, run.output);
            });
        });
    });
});
