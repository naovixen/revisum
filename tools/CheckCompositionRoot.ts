// A browser driver opened without its egress proxy would be a run with no egress enforcement, so
// production code builds drivers in one file: the composition root. Each command gets finished ports
// from it, so the names that build a driver, a proxy, a service caller or a run service do not appear
// in any other command. The test set builds its own drivers, and is not read here.
import { readFileSync } from "node:fs";
import { importedNames, takesModuleWhole } from "./check-imports.ts";
import { listSourceFiles, moduleSpecifiers, type ModuleSpecifier } from "./source-files.ts";
import { reportProblems } from "./workspace-packages.ts";

export const COMPOSITION_ROOT = "packages/cli/src/BuildAdapters.ts";

// The driver package's entry point re-exports what it defines; that makes nothing reachable the
// check of its importers does not see.
const DRIVER_ENTRY_POINT = "packages/driver-cdp/src/index.ts";
const CLI_SOURCES = "packages/cli/src/";

// Anywhere in the packages and tools, only the composition root may take these.
const DRIVER_BUILDERS = new Set(["cdpDriver", "egressThroughExistingProxy"]);
// Inside the cli package, only the composition root may take these: outside it they are legitimate,
// such as the runner's own use of its proxy.
const PORT_BUILDERS = new Set([
    "startProxyServer",
    "parseProxyRules",
    "serviceCaller",
    "createRunService",
]);

const isDriverPackageOrFile = (specifier: string): boolean =>
    specifier === "@revisum/driver-cdp" || specifier.endsWith("/CdpDriver.ts");

function problemsIn(path: string, loaded: ModuleSpecifier): readonly string[] {
    const taken = importedNames(loaded.clause ?? []);
    const builders = taken.filter(
        (name) =>
            DRIVER_BUILDERS.has(name) || (path.startsWith(CLI_SOURCES) && PORT_BUILDERS.has(name)),
    );
    const named = builders.map(
        (name) =>
            `${path}:${loaded.line} imports "${name}"; only ${COMPOSITION_ROOT} builds adapters, so a command gets finished ports and no caller can open a browser without its egress proxy`,
    );
    return isDriverPackageOrFile(loaded.specifier) && takesModuleWhole(loaded)
        ? [
              ...named,
              `${path}:${loaded.line} imports ${loaded.specifier} whole; only named imports can be checked, so the driver cannot be taken this way`,
          ]
        : named;
}

export function checkCompositionRoot(root: string): string[] {
    return listSourceFiles(root)
        .filter((path) => path !== COMPOSITION_ROOT && path !== DRIVER_ENTRY_POINT)
        .flatMap((path) =>
            moduleSpecifiers(readFileSync(`${root}/${path}`, "utf8")).flatMap((loaded) =>
                problemsIn(path, loaded),
            ),
        );
}

if (import.meta.main) {
    process.exitCode = reportProblems(
        "composition root check",
        checkCompositionRoot(process.cwd()),
    );
}
