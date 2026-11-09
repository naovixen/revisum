// The licence check gives each package a role and each role a licence: schemas, SDKs, drivers and
// adapters carry Apache-2.0; the engine carries FSL-1.1-ALv2; product packages may carry either.
// Every published JSON Schema is listed as Apache-2.0. axe-core's MPL-2.0 files must be the pinned
// release byte for byte, at the pinned version, and never copied into a package.
// Each test plants one change in a throw-away copy of the repository and runs the lint.
// A licence change is planted in both licences.json and the package's manifest, so the two still
// agree and only the role rule can catch it. For axe-core the lint gets its own installed-packages
// folder, holding a copy of axe-core to edit.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import {
    copyRepository,
    type LintChoice,
    type LintOutcome,
    type ScratchRepository,
} from "../support/ScratchRepository.ts";
import {
    assertLintFails,
    assertLintPasses,
    editJson,
    lintWithEdits,
} from "../support/WithEdits.ts";

const APACHE = "Apache-2.0";
const FSL = "FSL-1.1-ALv2";
const TIMEOUT = 300_000;

const ONLY_THE_RULE = { rule: RepositoryRuleName.Licences };

let scratch: ScratchRepository;
before(() => {
    scratch = copyRepository();
});
after(() => {
    scratch.dispose();
});

// Gives a package another licence in licences.json and in its own manifest.
function relicense(folder: string, licence: string, choice?: LintChoice): LintOutcome {
    return lintWithEdits(
        scratch,
        {
            "licences.json": editJson((map) => {
                const packages = map["packages"];
                if (typeof packages !== "object" || packages === null) {
                    throw new Error("licences.json has no packages map");
                }
                Object.assign(packages, { [folder]: licence });
            }),
            [`packages/${folder}/package.json`]: editJson((manifest) => {
                manifest["license"] = licence;
            }),
        },
        choice,
    );
}

test(
    "control: the unchanged copy of the repository passes every lint command",
    { timeout: TIMEOUT },
    () => {
        assertLintPasses(scratch.lint());
    },
);

// ---- Licences by role ---------------------------------------------------------------------------

for (const [folder, role] of [
    ["contracts", "schema"],
    ["driver-cdp", "driver"],
    ["report", "adapter"],
    ["auditor-axe", "adapter"],
] as const) {
    test(
        `the licence check fails when ${folder}, a ${role} package, carries the engine licence`,
        { timeout: TIMEOUT },
        () => {
            assertLintFails(relicense(folder, FSL, ONLY_THE_RULE), [folder]);
        },
    );
}

test("the licence check fails when the engine carries Apache-2.0", { timeout: TIMEOUT }, () => {
    assertLintFails(relicense("engine", APACHE, ONLY_THE_RULE), ["engine"]);
});

test(
    "counter-example: a product package may carry Apache-2.0 instead of the engine licence",
    { timeout: TIMEOUT },
    () => {
        assertLintPasses(relicense("cli", APACHE));
    },
);

test(
    "the licence check fails on a published JSON Schema that licences.json does not list",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithEdits(
            scratch,
            {
                "docs/plan-language/project.schema.json":
                    '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n',
            },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["project.schema.json"]);
    },
);

// ---- axe-core's files are the pinned release ----------------------------------------------------

// Runs the lint with an installed-packages folder that holds only a copy of axe-core, which `edit`
// may change. Nothing under the real node_modules is ever written. Omit `choice` for every command.
function lintWithInstalledAxe(
    edit: (axeFolder: string) => void,
    choice: LintChoice = {},
): LintOutcome {
    const modulesFolder = mkdtempSync(join(tmpdir(), "installed-packages-"));
    try {
        const axeFolder = join(modulesFolder, "axe-core");
        cpSync(join(REPOSITORY_ROOT, "node_modules", "axe-core"), axeFolder, { recursive: true });
        edit(axeFolder);
        return scratch.lint({ ...choice, modulesFolder });
    } finally {
        rmSync(modulesFolder, { recursive: true, force: true });
    }
}

test("control: an unedited copy of the installed axe-core passes", { timeout: TIMEOUT }, () => {
    assertLintPasses(lintWithInstalledAxe(() => {}));
});

for (const file of ["axe.min.js", "axe.js"]) {
    test(
        `the licence check fails when the installed ${file} differs from the pinned release by one byte`,
        { timeout: TIMEOUT },
        () => {
            const outcome = lintWithInstalledAxe((folder) => {
                const path = join(folder, file);
                writeFileSync(path, `${readFileSync(path, "utf8")} `);
            }, ONLY_THE_RULE);
            assertLintFails(outcome, [file]);
        },
    );
}

test(
    "the licence check fails when the installed axe-core is not the pinned version",
    { timeout: TIMEOUT },
    () => {
        const outcome = lintWithInstalledAxe((folder) => {
            const path = join(folder, "package.json");
            const manifest: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
            writeFileSync(path, `${JSON.stringify({ ...manifest, version: "4.13.0" }, null, 2)}\n`);
        }, ONLY_THE_RULE);
        assertLintFails(outcome, ["axe-core", "4.13.0"]);
    },
);

test(
    "the licence check fails when a package holds a copy of axe.min.js",
    { timeout: TIMEOUT },
    () => {
        const axe = readFileSync(
            join(REPOSITORY_ROOT, "node_modules", "axe-core", "axe.min.js"),
            "utf8",
        );
        const outcome = lintWithEdits(
            scratch,
            { "packages/auditor-axe/src/axe.min.js": axe },
            ONLY_THE_RULE,
        );
        assertLintFails(outcome, ["axe.min.js"]);
    },
);
