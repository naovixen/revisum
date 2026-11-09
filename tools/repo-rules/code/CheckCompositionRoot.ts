// A browser driver opened without its egress proxy would be a run with no egress enforcement, so
// production code builds drivers in one file: the composition root. Each command gets finished ports
// from it, so the names that build a driver, a proxy, a service caller or a run service do not appear
// in any other command. Other ways of starting a browser are refused too: a launcher, the test-only
// entry, a module named only while running, a created require, a built-in fetched from the running
// process, a loader hook, a thread or process of its own, and a relative reach into the driver's files.
// This reads tokens, so it guards against mistakes: it can't stop deliberate evasion, such as a
// built-in reached by a computed property. The test set builds its own drivers and launches, and is
// not read here.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { importedNames, takesModuleWhole } from "./CheckImports.ts";
import type { Token } from "../naming/LintRepository.ts";
import {
    closingParenthesis,
    codeTokens,
    isIdentifier,
    isPunctuator,
    listSourceFiles,
    moduleSpecifiers,
    type ModuleSpecifier,
} from "../ListSourceFiles.ts";
import { reportProblems } from "../ReadWorkspacePackages.ts";

export const COMPOSITION_ROOT = "packages/cli/src/wiring/BuildAdapters.ts";

// The driver package's entry points re-export what it defines; that makes nothing reachable the
// check of their importers does not see.
const DRIVER_ENTRY_POINTS = [
    "packages/driver-cdp/src/index.ts",
    "packages/driver-cdp/src/testing/index.ts",
];
const CLI_SOURCES = "packages/cli/src/";
const PACKAGE_SOURCES = "packages/";

// Anywhere in the packages and tools, only the composition root may take these.
const DRIVER_BUILDERS = new Set(["cdpDriver", "egressThroughExistingProxy"]);
const DRIVER_SOURCES = "packages/driver-cdp/src/";
const DRIVER_PACKAGE = "packages/driver-cdp/";
const ACCESSIBILITY_PACKAGE = "@revisum/auditor-act";
// Inside the cli package, only the composition root may take these: outside it they are legitimate,
// such as the runner's own use of its proxy.
const PORT_BUILDERS = new Set([
    "startProxyServer",
    "parseProxyRules",
    "serviceCaller",
    "createRunService",
]);
// Each launcher, and the only files that may take it.
const LAUNCHER_ALLOWED_FILES = new Map<string, readonly string[]>([
    // The accessibility scan's own browser, which takes no flags and opens no run.
    ["launchChromium", ["packages/auditor-act/src/page/LaunchBrowser.ts"]],
    ["launchSharedBrowser", []],
    // The driver's own launch, the one production use of a flag list of its own.
    ["launchChromiumWithArguments", ["packages/driver-cdp/src/launch/SharedBrowser.ts"]],
    // The accessibility package's launcher, re-exported from its entry and used by nothing else here.
    ["launchBrowser", ["packages/auditor-act/src/index.ts"]],
]);
const TEST_ONLY_DRIVER_ENTRY = "@revisum/driver-cdp/testing";

// The packages that manage processes: the browser's, and the containers'.
const PROCESS_PACKAGES = ["packages/driver-cdp/", "packages/runner/"];
const PROCESS_MODULES = new Set(["node:child_process", "child_process"]);
const MAY_START_A_PROCESS = new Set([
    // Reads the git commit a run is pinned to.
    "packages/cli/src/commands/RunPins.ts",
]);
const THREAD_MODULES = new Set(["node:worker_threads", "worker_threads"]);
const MODULE_LOADERS = new Set(["node:module", "module"]);
const NOT_FOR_THE_BUILT_IN_LOADER = new Set([
    ...PROCESS_MODULES,
    ...THREAD_MODULES,
    ...MODULE_LOADERS,
]);
const BUILT_IN_LOADER = "getBuiltinModule";
const MAY_CREATE_A_REQUIRE = new Set([
    // Finds the axe-core file it reads, by the package's own resolution.
    "packages/auditor-axe/src/audit/RunAxe.ts",
]);

const isDriverPackageOrFile = (specifier: string): boolean =>
    specifier === "@revisum/driver-cdp" ||
    specifier.endsWith("/CdpDriver.ts") ||
    specifier.endsWith("/LaunchChromium.ts") ||
    specifier.endsWith("/SharedBrowser.ts");

const isTestOnlyDriverEntry = (specifier: string): boolean =>
    specifier === TEST_ONLY_DRIVER_ENTRY || specifier.endsWith("/testing/index.ts");

const takesPackageThatCanStartABrowser = (specifier: string): boolean =>
    isDriverPackageOrFile(specifier) || specifier === ACCESSIBILITY_PACKAGE;

function namedBuilderProblems(
    path: string,
    loaded: ModuleSpecifier,
    taken: readonly string[],
): readonly string[] {
    const builders = taken.filter(
        (name) =>
            DRIVER_BUILDERS.has(name) || (path.startsWith(CLI_SOURCES) && PORT_BUILDERS.has(name)),
    );
    const launchers = taken.filter(
        (name) => LAUNCHER_ALLOWED_FILES.get(name)?.includes(path) === false,
    );
    return [...builders, ...launchers].map(
        (name) =>
            `${path}:${loaded.line} imports "${name}"; only ${COMPOSITION_ROOT} builds adapters, so a command gets finished ports and no caller can open a browser without its egress proxy`,
    );
}

function moduleWholeProblems(path: string, loaded: ModuleSpecifier): readonly string[] {
    return takesPackageThatCanStartABrowser(loaded.specifier) && takesModuleWhole(loaded)
        ? [
              `${path}:${loaded.line} imports ${loaded.specifier} whole; only named imports can be checked, so it cannot be taken this way`,
          ]
        : [];
}

// A file the packages may not use for its own browser or process, whatever is taken from it.
function refusedModuleProblems(
    path: string,
    loaded: ModuleSpecifier,
    taken: readonly string[],
): readonly string[] {
    const { specifier, line, isTypeOnly } = loaded;
    if (isTypeOnly || !path.startsWith(PACKAGE_SOURCES)) {
        return [];
    }
    if (isTestOnlyDriverEntry(specifier)) {
        return [
            `${path}:${line} imports ${specifier}; the test-only driver entry is for tests alone`,
        ];
    }
    const canStartProcesses =
        PROCESS_PACKAGES.some((folder) => path.startsWith(folder)) || MAY_START_A_PROCESS.has(path);
    if (PROCESS_MODULES.has(specifier) && !canStartProcesses) {
        return [
            `${path}:${line} imports ${specifier}; only the driver and the runner start processes`,
        ];
    }
    const isCreatingARequire =
        MODULE_LOADERS.has(specifier) &&
        (taken.includes("createRequire") || takesModuleWhole(loaded));
    if (isCreatingARequire && !MAY_CREATE_A_REQUIRE.has(path)) {
        return [
            `${path}:${line} takes createRequire from ${specifier}; a created require can load a package no rule reads`,
        ];
    }
    if (THREAD_MODULES.has(specifier)) {
        return [`${path}:${line} imports ${specifier}; a thread can load a module no rule reads`];
    }
    if (MODULE_LOADERS.has(specifier) && taken.includes("register")) {
        return [
            `${path}:${line} takes register from ${specifier}; a loader hook can change what any import loads`,
        ];
    }
    return [];
}

// A relative path that lands in the driver's own files, from anywhere else. Types included: the only
// way in is through the driver's entry points, where what is offered can be read.
function reachIntoDriverProblems(path: string, loaded: ModuleSpecifier): readonly string[] {
    const isRelative = loaded.specifier.startsWith(".");
    const landsIn = posix.normalize(posix.join(posix.dirname(path), loaded.specifier));
    return isRelative && landsIn.startsWith(DRIVER_SOURCES) && !path.startsWith(DRIVER_PACKAGE)
        ? [
              `${path}:${loaded.line} imports ${loaded.specifier}; the driver's own files are reached only through its entry points`,
          ]
        : [];
}

function problemsIn(path: string, loaded: ModuleSpecifier): readonly string[] {
    const taken = importedNames(loaded.clause ?? []);
    return [
        ...namedBuilderProblems(path, loaded, taken),
        ...moduleWholeProblems(path, loaded),
        ...refusedModuleProblems(path, loaded, taken),
    ];
}

// `import(name: string): unknown` in a type or object: a method called import, not a loaded module.
function isMethodCalledImport(tokens: readonly Token[], index: number): boolean {
    const before = tokens[index - 1];
    const isListEntry =
        isPunctuator(before, "{") || isPunctuator(before, ",") || isPunctuator(before, ";");
    return isListEntry && isPunctuator(tokens[closingParenthesis(tokens, index + 1) + 1], ":");
}

// True when the argument is a single fixed string: a template with a substitution is several tokens.
function namesAFixedModule(tokens: readonly Token[], index: number): boolean {
    const argument = tokens[index + 2];
    const after = tokens[index + 3];
    return (
        (argument?.kind === "string" || argument?.kind === "template") &&
        (isPunctuator(after, ")") || isPunctuator(after, ","))
    );
}

// Each dynamic import whose module can only be known while it runs, so no rule can read it.
function computedImportProblems(path: string, source: string): readonly string[] {
    if (!path.startsWith(PACKAGE_SOURCES)) {
        return [];
    }
    const tokens = codeTokens(source);
    return [...tokens.entries()].flatMap(([index, token]) => {
        const isDynamicImport =
            isIdentifier(token, "import") &&
            !isPunctuator(tokens[index - 1], ".") &&
            isPunctuator(tokens[index + 1], "(");
        return isDynamicImport &&
            !isMethodCalledImport(tokens, index) &&
            !namesAFixedModule(tokens, index)
            ? [
                  `${path}:${token.line} imports a module named only while running, which no rule can read`,
              ]
            : [];
    });
}

// Each call of the running process's built-in loader for a module the packages may not take, or one
// whose name is known only while running.
function builtInLoaderProblems(path: string, source: string): readonly string[] {
    if (!path.startsWith(PACKAGE_SOURCES)) {
        return [];
    }
    const tokens = codeTokens(source);
    return [...tokens.entries()].flatMap(([index, token]) => {
        if (!isIdentifier(token, BUILT_IN_LOADER) || !isPunctuator(tokens[index + 1], "(")) {
            return [];
        }
        const named = tokens[index + 2]?.text ?? "";
        return namesAFixedModule(tokens, index) && !NOT_FOR_THE_BUILT_IN_LOADER.has(named)
            ? []
            : [
                  `${path}:${token.line} calls ${BUILT_IN_LOADER} for a module the packages may not take this way, or one named only while running`,
              ];
    });
}

export function checkCompositionRoot(root: string): string[] {
    return listSourceFiles(root).flatMap((path) => {
        const source = readFileSync(`${root}/${path}`, "utf8");
        const loadedModules = moduleSpecifiers(source);
        const isRuled = path !== COMPOSITION_ROOT && !DRIVER_ENTRY_POINTS.includes(path);
        return [
            ...loadedModules.flatMap((loaded) => reachIntoDriverProblems(path, loaded)),
            ...(isRuled
                ? [
                      ...loadedModules.flatMap((loaded) => problemsIn(path, loaded)),
                      ...computedImportProblems(path, source),
                      ...builtInLoaderProblems(path, source),
                  ]
                : []),
        ];
    });
}

if (import.meta.main) {
    process.exitCode = reportProblems(
        "composition root check",
        checkCompositionRoot(process.cwd()),
    );
}
