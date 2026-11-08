// The composition root is the one place production code builds a browser, so the other ways of starting
// one must be refused as well: a launcher that takes its own flags, a shared browser, a module whose
// name can only be read while running, and a process of its own. Each case is one planted file, read
// by the rule alone in an otherwise empty folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { checkCompositionRoot } from "../../tools/CheckCompositionRoot.ts";
import { REPOSITORY_ROOT } from "../support/repository.ts";

type Planted = { readonly name: string; readonly path: string; readonly source: string };

const inReport = (file: string): string => `packages/report/src/${file}`;
const inCli = (file: string): string => `packages/cli/src/${file}`;

function problemsWith({ path, source }: Pick<Planted, "path" | "source">): readonly string[] {
    const root = mkdtempSync(join(tmpdir(), "composition-root-"));
    try {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source);
        return checkCompositionRoot(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const REFUSED: readonly Planted[] = [
    {
        name: "the launcher named from the driver's entry",
        path: inReport("planted-launcher.ts"),
        source: "import { launchChromium } from '@revisum/driver-cdp';\nexport const start = launchChromium;\n",
    },
    {
        name: "the launcher under another name",
        path: inCli("planted-renamed-launcher.ts"),
        source: 'import { launchChromium as start } from "@revisum/driver-cdp";\nexport const open = start;\n',
    },
    {
        name: "the launcher named by a relative path",
        path: inReport("planted-relative-launcher.ts"),
        source: "import { launchChromium } from '../../driver-cdp/src/launch/LaunchChromium.ts';\nexport const start = launchChromium;\n",
    },
    {
        name: "the launcher re-exported",
        path: inReport("planted-launcher-export.ts"),
        source: "export { launchChromium } from '@revisum/driver-cdp';\n",
    },
    {
        name: "the launcher in the accessibility package's other files",
        path: "packages/auditor-act/src/planted-launcher.ts",
        source: "import { launchChromium } from '@revisum/driver-cdp';\nexport const start = launchChromium;\n",
    },
    {
        name: "the shared browser",
        path: inReport("planted-shared-browser.ts"),
        source: "import { launchSharedBrowser } from '@revisum/driver-cdp/testing';\nexport const start = launchSharedBrowser;\n",
    },
    {
        name: "the shared browser from the driver's entry",
        path: inCli("planted-shared-browser-entry.ts"),
        source: "import { launchSharedBrowser } from '@revisum/driver-cdp';\nexport const start = launchSharedBrowser;\n",
    },
    {
        name: "the whole of the driver's test-only entry",
        path: inReport("planted-test-entry.ts"),
        source: "import * as testing from '@revisum/driver-cdp/testing';\nexport const reached = testing;\n",
    },
    {
        name: "a dynamic import of a computed name",
        path: inReport("planted-computed-import.ts"),
        source: "export const load = (name: string): Promise<unknown> => import(name);\n",
    },
    {
        name: "a dynamic import of a template that opens with its substitution",
        path: inCli("planted-computed-template.ts"),
        source: "export const load = (name: string): Promise<unknown> => import(`${name}/driver`);\n",
    },
    {
        name: "a created require called at once on the driver",
        path: inReport("planted-created-require.ts"),
        source: 'import { createRequire } from "node:module";\nexport const driver: unknown = createRequire(import.meta.url)("@revisum/driver-cdp");\n',
    },
    {
        name: "a created require kept under another name",
        path: inCli("planted-named-require.ts"),
        source: "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const driver: unknown = load('@revisum/driver-cdp');\n",
    },
    {
        name: "a named import of the process module",
        path: inReport("planted-spawn.ts"),
        source: 'import { spawn } from "node:child_process";\nexport const start = spawn;\n',
    },
    {
        name: "the process module without its prefix",
        path: inCli("planted-bare-spawn.ts"),
        source: "import { spawnSync } from 'child_process';\nexport const start = spawnSync;\n",
    },
    {
        name: "the whole of the process module",
        path: inReport("planted-whole-spawn.ts"),
        source: "import * as processes from 'node:child_process';\nexport const start = processes;\n",
    },
    {
        name: "a dynamic import of the process module",
        path: inReport("planted-dynamic-spawn.ts"),
        source: "export const processes = (): Promise<unknown> => import('node:child_process');\n",
    },
];

const LET_BE: readonly Planted[] = [
    {
        name: "the accessibility engine's own launcher",
        path: "packages/auditor-act/src/chromium-page.ts",
        source: "import { launchChromium } from '@revisum/driver-cdp';\nexport const start = launchChromium;\n",
    },
    {
        name: "the process module in the runner",
        path: "packages/runner/src/planted-container-engine.ts",
        source: "import { spawn } from 'node:child_process';\nexport const start = spawn;\n",
    },
    {
        name: "the process module in the driver",
        path: "packages/driver-cdp/src/planted-launch.ts",
        source: "import { spawn } from 'node:child_process';\nexport const start = spawn;\n",
    },
    {
        name: "a dynamic import of a fixed local module",
        path: inReport("planted-local-import.ts"),
        source: "export const load = (): Promise<unknown> => import('./local.ts');\n",
    },
    {
        name: "a method that happens to be called import",
        path: inReport("planted-method.ts"),
        source: "export const load = (loader: { import(name: string): unknown }, name: string): unknown => loader.import(name);\n",
    },
    {
        name: "the names only in a comment and a string",
        path: inReport("planted-mention.ts"),
        source: "// launchChromium, createRequire and import(name) are only mentioned here.\nexport const note = 'launchSharedBrowser and node:child_process';\n",
    },
];

describe("Using the composition root rule", () => {
    for (const planted of REFUSED) {
        describe(`given ${planted.name} outside the driver`, () => {
            describe("when the rule reads the packages", () => {
                test("then it should refuse the file", () => {
                    const problems = problemsWith(planted);
                    assert.ok(
                        problems.some((problem) => problem.includes(planted.path)),
                        `nothing named ${planted.path}: ${JSON.stringify(problems)}`,
                    );
                });
            });
        });
    }

    for (const planted of LET_BE) {
        describe(`given ${planted.name}`, () => {
            describe("when the rule reads the packages", () => {
                test("then it should let it be", () => {
                    assert.deepEqual(problemsWith(planted), []);
                });
            });
        });
    }

    describe("given the repository as it stands", () => {
        describe("when the rule reads the packages", () => {
            test("then it should find nothing", () => {
                assert.deepEqual(checkCompositionRoot(REPOSITORY_ROOT), []);
            });
        });
    });
});
