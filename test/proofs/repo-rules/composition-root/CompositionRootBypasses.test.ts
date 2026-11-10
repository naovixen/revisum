// The composition root is the one place production code builds a browser, so the other ways of starting
// one must be refused as well: a launcher that takes its own flags, a shared browser, a module whose
// name can only be read while running, a process or thread of its own, and a reach into the driver's
// own files. Each case is one planted file, read by the rule alone in an otherwise empty folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { checkCompositionRoot } from "../../../../tools/repo-rules/code/CheckCompositionRoot.ts";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";

type Planted = { readonly name: string; readonly path: string; readonly source: string };

const inReport = (file: string): string => `packages/report/src/${file}`;
const inCli = (file: string): string => `packages/cli/src/${file}`;
const inDriver = (file: string): string => `packages/driver-cdp/src/${file}`;
const inRunner = (file: string): string => `packages/runner/src/${file}`;

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
    {
        name: "the accessibility scan's launcher from its package",
        path: inCli("planted-scan-launcher.ts"),
        source: "import { launchBrowser } from '@revisum/auditor-act';\nexport const start = launchBrowser;\n",
    },
    {
        name: "the accessibility scan's launcher under another name",
        path: inReport("planted-renamed-scan-launcher.ts"),
        source: 'import { launchBrowser as start } from "@revisum/auditor-act";\nexport const open = start;\n',
    },
    {
        name: "the accessibility scan's launcher named by a relative path",
        path: inCli("planted-relative-scan-launcher.ts"),
        source: "import { launchBrowser } from '../../auditor-act/src/page/LaunchBrowser.ts';\nexport const start = launchBrowser;\n",
    },
    {
        name: "the whole of the accessibility package, where the launcher could hide",
        path: inCli("planted-whole-scan-package.ts"),
        source: "import * as scanning from '@revisum/auditor-act';\nexport const reached = scanning;\n",
    },
    {
        name: "the process module from the running process's built-ins",
        path: inReport("planted-builtin-spawn.ts"),
        source: "export const processes: unknown = process.getBuiltinModule('node:child_process');\n",
    },
    {
        name: "the process module from the built-ins without its prefix",
        path: inCli("planted-bare-builtin-spawn.ts"),
        source: 'export const processes: unknown = process.getBuiltinModule("child_process");\n',
    },
    {
        name: "the process module from the built-ins in the driver",
        path: inDriver("planted-builtin-spawn.ts"),
        source: 'export const processes: unknown = process.getBuiltinModule("node:child_process");\n',
    },
    {
        name: "the thread module from the built-ins",
        path: inCli("planted-builtin-threads.ts"),
        source: "export const threads: unknown = process.getBuiltinModule('node:worker_threads');\n",
    },
    {
        name: "the module loader from the built-ins",
        path: inReport("planted-builtin-loader.ts"),
        source: 'export const loader: unknown = process.getBuiltinModule("node:module");\n',
    },
    {
        name: "a built-in whose name is known only while running",
        path: inReport("planted-computed-builtin.ts"),
        source: "export const load = (name: string): unknown => process.getBuiltinModule(name);\n",
    },
    {
        name: "a named import of the thread module",
        path: inReport("planted-worker.ts"),
        source: "import { Worker } from 'node:worker_threads';\nexport const start = Worker;\n",
    },
    {
        name: "the thread module without its prefix",
        path: inCli("planted-bare-worker.ts"),
        source: 'import { Worker } from "worker_threads";\nexport const start = Worker;\n',
    },
    {
        name: "the whole of the thread module",
        path: inReport("planted-whole-worker.ts"),
        source: "import * as threads from 'node:worker_threads';\nexport const start = threads;\n",
    },
    {
        name: "a dynamic import of the thread module",
        path: inCli("planted-dynamic-worker.ts"),
        source: "export const threads = (): Promise<unknown> => import('node:worker_threads');\n",
    },
    {
        name: "the thread module in the runner",
        path: inRunner("planted-worker.ts"),
        source: "import { Worker } from 'node:worker_threads';\nexport const start = Worker;\n",
    },
    {
        name: "a module loader hook registered",
        path: inReport("planted-register.ts"),
        source: "import { register } from 'node:module';\nexport const hook = register;\n",
    },
    {
        name: "a module loader hook registered without the prefix",
        path: inCli("planted-bare-register.ts"),
        source: 'import { register } from "module";\nexport const hook = register;\n',
    },
    {
        name: "a module loader hook under another name",
        path: inReport("planted-renamed-register.ts"),
        source: "import { register as hook } from 'node:module';\nexport const install = hook;\n",
    },
    {
        name: "the driver's own launch, reached by a relative path",
        path: inReport("planted-own-launch.ts"),
        source: "import { launchOwnBrowser } from '../../driver-cdp/src/launch/SharedBrowser.ts';\nexport const start = launchOwnBrowser;\n",
    },
    {
        name: "the driver's attach to a shared browser, from a deeper folder",
        path: inCli("planted/deeper/planted-attach.ts"),
        source: 'import { attachToSharedBrowser } from "../../../../driver-cdp/src/launch/SharedBrowser.ts";\nexport const start = attachToSharedBrowser;\n',
    },
    {
        name: "the driver's session maker, reached by a relative path",
        path: inReport("planted-create-session.ts"),
        source: "import { createSession } from '../../driver-cdp/src/session/CreateSession.ts';\nexport const start = createSession;\n",
    },
    {
        name: "the driver's session maker re-exported",
        path: inCli("planted-create-session-export.ts"),
        source: 'export { createSession } from "../../driver-cdp/src/session/CreateSession.ts";\n',
    },
    {
        name: "a dynamic import of the driver's session maker",
        path: inReport("planted-dynamic-create-session.ts"),
        source: "export const load = (): Promise<unknown> => import('../../driver-cdp/src/session/CreateSession.ts');\n",
    },
    {
        name: "a name of no consequence from a file of the driver's",
        path: inReport("planted-driver-helper.ts"),
        source: "import { errorText } from '../../driver-cdp/src/connection/ErrorText.ts';\nexport const describe = errorText;\n",
    },
    {
        name: "the whole of a file of the driver's",
        path: inCli("planted-whole-driver-file.ts"),
        source: "import * as text from '../../driver-cdp/src/connection/ErrorText.ts';\nexport const reached = text;\n",
    },
    {
        name: "a type from a file of the driver's",
        path: inReport("planted-driver-type.ts"),
        source: "import type { SharedBrowser } from '../../driver-cdp/src/launch/SharedBrowser.ts';\nexport type Reached = SharedBrowser;\n",
    },
    {
        name: "a file of the driver's reached the long way round",
        path: inReport("planted-long-way-round.ts"),
        source: "import { createSession } from '../../report/../driver-cdp/src/session/CreateSession.ts';\nexport const start = createSession;\n",
    },
    {
        name: "a file of the driver's reached from the accessibility package",
        path: "packages/auditor-act/src/planted-reach.ts",
        source: "import { createSession } from '../../driver-cdp/src/session/CreateSession.ts';\nexport const start = createSession;\n",
    },
    {
        name: "a file of the driver's reached from the tools",
        path: "tools/planted-reach.ts",
        source: "import { createSession } from '../packages/driver-cdp/src/session/CreateSession.ts';\nexport const start = createSession;\n",
    },
];

const LET_BE: readonly Planted[] = [
    {
        name: "the accessibility engine's own launcher",
        path: "packages/auditor-act/src/page/LaunchBrowser.ts",
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
    {
        name: "the accessibility package's entry naming its own launcher",
        path: "packages/auditor-act/src/index.ts",
        source: "export { launchBrowser, SCAN_VIEWPORT } from './page/LaunchBrowser.ts';\n",
    },
    {
        name: "other names from the accessibility package",
        path: inCli("planted-scan-rules.ts"),
        source: "import { ALL_RULES, SCAN_VIEWPORT } from '@revisum/auditor-act';\nexport const pins = [ALL_RULES, SCAN_VIEWPORT];\n",
    },
    {
        name: "the file that finds axe-core with a created require",
        path: "packages/auditor-axe/src/audit/RunAxe.ts",
        source: "import { createRequire } from 'node:module';\nexport const resolve = createRequire(import.meta.url).resolve;\n",
    },
    {
        name: "the new ways only mentioned in a comment and a string",
        path: inReport("planted-other-mention.ts"),
        source: "// process.getBuiltinModule('node:child_process') and register are only mentioned here.\nexport const note = 'node:worker_threads and ../../driver-cdp/src/session/CreateSession.ts';\n",
    },
    {
        name: "a method and a local function that happen to be called register",
        path: inReport("planted-local-register.ts"),
        source: "import { register } from './registry.ts';\nexport const add = (loader: { register(name: string): unknown }): unknown => loader.register(String(register));\n",
    },
    {
        name: "the driver reaching its own files",
        path: inDriver("planted-own-files.ts"),
        source: "import { createSession } from './session/CreateSession.ts';\nimport { attachToSharedBrowser, launchOwnBrowser } from './launch/SharedBrowser.ts';\nexport const parts = [createSession, attachToSharedBrowser, launchOwnBrowser];\n",
    },
    {
        name: "a local folder that only looks like the driver's",
        path: inReport("planted-look-alike.ts"),
        source: "import { createSession } from './driver-cdp/src/session/CreateSession.ts';\nexport const start = createSession;\n",
    },
    {
        name: "a name the driver's entry offers",
        path: "packages/auditor-act/src/planted-connection.ts",
        source: "import { CdpConnection } from '@revisum/driver-cdp';\nexport const connection = CdpConnection;\n",
    },
];

describe("Using the composition root rule", () => {
    for (const planted of REFUSED) {
        describe(`given ${planted.name}`, () => {
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
