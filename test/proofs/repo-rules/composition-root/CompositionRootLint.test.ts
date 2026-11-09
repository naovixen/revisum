// A driver with no egress proxy must not be buildable by accident, so one file in the packages builds
// drivers. Reading source text means matching both quote styles and surviving line wrapping, so the
// counter-examples below check the reading itself: each form a real import can take is caught, and
// what merely mentions the name or brings in something else is not.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";
import { PACKAGES, REPOSITORY_ROOT } from "#test-support/repository/RepositoryRoot.ts";

const COMPOSITION_ROOT = "packages/cli/src/wiring/BuildAdapters.ts";

const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A value import or a re-export from another package that names the driver, however it is wrapped or
// renamed, or a way of importing the driver's package that could reach it without naming it. A
// `type` import brings in no value, and the driver's package's own entry point re-exports it by a
// relative path, so neither counts.
const NAMED_IMPORT = /\bimport\s+\{[^}]*?(?<!type\s)\bcdpDriver\b[^}]*\}\s*from\s*["'][^"']+["']/;
const DRIVER_PACKAGE = String.raw`["']@revisum/driver-cdp["']`;
const REEXPORT = new RegExp(
    String.raw`\bexport\s+\{[^}]*\bcdpDriver\b[^}]*\}\s*from\s*${DRIVER_PACKAGE}`,
);
const WHOLE_PACKAGE_IMPORT = new RegExp(
    String.raw`\bimport\s+\*\s+as\s+\w+\s+from\s*${DRIVER_PACKAGE}`,
);
const WHOLE_PACKAGE_REEXPORT = new RegExp(
    String.raw`\bexport\s+\*(\s+as\s+\w+)?\s+from\s*${DRIVER_PACKAGE}`,
);
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*${DRIVER_PACKAGE}\s*\)`);

const importsCdpDriver = (source: string): boolean => {
    const code = withoutComments(source);
    return [
        NAMED_IMPORT,
        REEXPORT,
        WHOLE_PACKAGE_IMPORT,
        WHOLE_PACKAGE_REEXPORT,
        DYNAMIC_IMPORT,
    ].some((form) => form.test(code));
};

function sourceFiles(folder: string): readonly string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
        }
        return entry.name.endsWith(".ts") ? [path] : [];
    });
}

const repositoryPath = (path: string): string =>
    relative(REPOSITORY_ROOT, path).split(sep).join("/");

const FORMS_THAT_IMPORT: readonly (readonly [string, string])[] = [
    ["double quotes", `import { cdpDriver } from "@revisum/driver-cdp";`],
    ["single quotes", `import { cdpDriver } from '@revisum/driver-cdp';`],
    [
        "a wrapped list",
        `import {\n    CdpConnection,\n    cdpDriver,\n    type OwnBrowserDriver,\n} from "@revisum/driver-cdp";`,
    ],
    ["a new name", `import { cdpDriver as makeDriver } from "@revisum/driver-cdp";`],
    ["a relative path", `import { cdpDriver } from './cdp-driver.ts';`],
    [
        "a list that opens with a type",
        `import { type CdpDriverOptions, cdpDriver } from "@revisum/driver-cdp";`,
    ],
    ["a re-export", `export { cdpDriver } from "@revisum/driver-cdp";`],
    ["the whole package", `import * as driver from "@revisum/driver-cdp";`],
    ["the whole package again", `export * from '@revisum/driver-cdp';`],
    ["a dynamic import", `const driver = await import("@revisum/driver-cdp");`],
];

const FORMS_THAT_DO_NOT: readonly (readonly [string, string])[] = [
    ["another export of the package", `import { CdpConnection } from "@revisum/driver-cdp";`],
    ["only the driver's types", `import type { CdpDriverOptions } from "@revisum/driver-cdp";`],
    [
        "a type in a mixed list",
        `import { type CdpDriverOptions, launchChromium } from "@revisum/driver-cdp";`,
    ],
    ["a mention in a comment", `// import { cdpDriver } from "@revisum/driver-cdp";`],
    ["the name in a string", `const message = "cdpDriver needs an egress source";`],
    [
        "the driver package's own entry point",
        `export { cdpDriver, type CdpDriverOptions } from './cdp-driver.ts';`,
    ],
    ["a name that only contains it", `import { cdpDriverOptions } from "./elsewhere.ts";`],
];

describe("Using the composition root lint", () => {
    describe("given every source file in the packages", () => {
        describe("when the lint looks for what imports the browser driver", () => {
            test("then it should find only the composition root", () => {
                const found = sourceFiles(PACKAGES)
                    .filter((path) => importsCdpDriver(readFileSync(path, "utf8")))
                    .map(repositoryPath);
                assert.deepEqual(found, [COMPOSITION_ROOT]);
            });
        });
    });

    for (const [title, source] of FORMS_THAT_IMPORT) {
        describe(`given source that imports the driver with ${title}`, () => {
            describe("when the lint reads it", () => {
                test("then it should catch it", () => {
                    assert.equal(importsCdpDriver(source), true);
                });
            });
        });
    }

    for (const [title, source] of FORMS_THAT_DO_NOT) {
        describe(`given source with ${title}`, () => {
            describe("when the lint reads it", () => {
                test("then it should let it be", () => {
                    assert.equal(importsCdpDriver(source), false);
                });
            });
        });
    }
});
