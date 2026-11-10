// Keeps the trusted packages free of outside code. The compiler already rejects an import of a
// workspace package that a package's tsconfig.json does not reference; this check adds what the
// compiler cannot see: `contracts` and `engine` may import only Node built-ins, their own files
// and (for `engine`) `contracts`, and neither may declare a runtime dependency.
//
// It also keeps route code to drafts. A plan-authoring route, such as the draft command, hands on
// a PlanDraft and nothing more, so it may not import the engine's run service (under any name)
// or the brand constructor, nor import the engine whole, where either could hide. (A Plan made by
// a cast is refused by tools/repo-rules/code/CheckBrandedCasts.ts.)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Token } from "../naming/LintRepository.ts";
import {
    isIdentifier,
    isPunctuator,
    moduleSpecifiers,
    type ModuleSpecifier,
} from "../ListSourceFiles.ts";
import {
    readWorkspacePackages,
    reportProblems,
    type WorkspacePackage,
} from "../ReadWorkspacePackages.ts";

// Package folder, then the workspace package folders it may import.
const TRUSTED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
    contracts: [],
    engine: ["contracts"],
};

// The modules that are route code, by repository-relative path.
export const ROUTE_MODULES: readonly string[] = ["packages/cli/src/commands/DraftCommand.ts"];
// What route code may not take from a workspace package: the run service that is the way into the
// run, the name the run function was once exported under, and the brand constructor.
const NAMES_ROUTE_CODE_MAY_NOT_IMPORT = new Set(["createRunService", "run", "brand"]);
const WORKSPACE_SCOPE = "@revisum/";
// Each of these reaches a package's users when it is installed. Dev dependencies never run.
const RUNTIME_DEPENDENCY_SECTIONS = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
] as const;

function listSourceFiles(folder: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(path));
        } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
            files.push(path);
        }
    }
    return files;
}

function packageName(workspacePackages: readonly WorkspacePackage[], folder: string): string {
    const name = workspacePackages.find((workspacePackage) => workspacePackage.folder === folder)
        ?.manifest.name;
    return typeof name === "string" ? name : folder;
}

// The name an entry of `{ a, type b, c as d }` takes from the module, never its local alias.
function importedName(entry: readonly Token[]): string | undefined {
    const hasTypeModifier =
        isIdentifier(entry[0], "type") && entry.length > 1 && !isIdentifier(entry[1], "as");
    return (hasTypeModifier ? entry[1] : entry[0])?.text;
}

// The names a statement's `{ … }` takes from the module.
export function importedNames(clause: readonly Token[]): string[] {
    const open = clause.findIndex((token) => isPunctuator(token, "{"));
    if (open === -1) {
        return [];
    }
    const close = clause.findIndex((token) => isPunctuator(token, "}"));
    const entries: Token[][] = [[]];
    for (const token of clause.slice(open + 1, close)) {
        if (isPunctuator(token, ",")) {
            entries.push([]);
        } else {
            entries.at(-1)?.push(token);
        }
    }
    return entries.map(importedName).filter((name) => name !== undefined);
}

// A dynamic import, a require, a namespace, a default import or `export *`: anything but `{ … }`,
// or an import for its side effects, which takes no names at all.
export function takesModuleWhole({ clause, isTypeOnly }: ModuleSpecifier): boolean {
    if (clause === undefined) {
        return true;
    }
    const firstTaken = isTypeOnly ? clause[1] : clause[0];
    return firstTaken !== undefined && !isPunctuator(firstTaken, "{");
}

// Each problem with a route module's imports: a forbidden name, or a workspace package imported whole.
export function checkRouteImports(root: string): string[] {
    const problems: string[] = [];
    for (const module of ROUTE_MODULES) {
        const path = join(root, module);
        if (!existsSync(path)) {
            problems.push(`${module} is listed as route code but does not exist`);
            continue;
        }
        const workspaceImports = moduleSpecifiers(readFileSync(path, "utf8")).filter((loaded) =>
            loaded.specifier.startsWith(WORKSPACE_SCOPE),
        );
        for (const loaded of workspaceImports) {
            for (const imported of importedNames(loaded.clause ?? [])) {
                if (NAMES_ROUTE_CODE_MAY_NOT_IMPORT.has(imported)) {
                    problems.push(
                        `${module} imports "${imported}" from ${loaded.specifier}; route code hands on drafts, so it may not import the run service or the brand constructor`,
                    );
                }
            }
            if (takesModuleWhole(loaded)) {
                problems.push(
                    `${module} imports ${loaded.specifier} whole; route code imports only the names it needs, so the run service cannot hide in it`,
                );
            }
        }
    }
    return problems;
}

const hasEntries = (section: unknown): boolean =>
    typeof section === "object" && section !== null && Object.keys(section).length > 0;

export function checkImports(root: string): string[] {
    const problems: string[] = [...checkRouteImports(root)];
    const workspacePackages = readWorkspacePackages(root);

    for (const [folder, allowedFolders] of Object.entries(TRUSTED_PACKAGES)) {
        const workspacePackage = workspacePackages.find((candidate) => candidate.folder === folder);
        if (workspacePackage === undefined) {
            problems.push(`packages/${folder} is missing`);
            continue;
        }
        for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
            if (hasEntries(workspacePackage.manifest[section])) {
                problems.push(
                    `packages/${folder}/package.json declares runtime dependencies in ${section}; it must have none`,
                );
            }
        }
        const allowedPackages = allowedFolders.map((allowed) =>
            packageName(workspacePackages, allowed),
        );
        for (const file of listSourceFiles(join(workspacePackage.path, "src"))) {
            for (const { specifier } of moduleSpecifiers(readFileSync(file, "utf8"))) {
                const isAllowed =
                    specifier.startsWith("node:") ||
                    specifier.startsWith(".") ||
                    allowedPackages.includes(specifier);
                if (!isAllowed) {
                    problems.push(
                        `${file.slice(root.length + 1)} imports "${specifier}"; ${folder} may import only Node built-ins (node:…), its own files${allowedPackages.length > 0 ? ` and ${allowedPackages.join(", ")}` : ""}`,
                    );
                }
            }
        }
    }
    return problems;
}

if (import.meta.main) {
    process.exitCode = reportProblems("import check", checkImports(process.cwd()));
}
