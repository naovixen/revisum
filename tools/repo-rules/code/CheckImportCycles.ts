// Fails on any import cycle between the source files of packages/ and tools/. A cycle can crash
// at load time, when a module reads a binding of one that has not finished evaluating, and the
// compiler cannot see that. Static imports and `export … from` count; a dynamic import loads
// later, on demand, so it never takes part.
//
// A type-only import, `import type …` or `export type … from`, is erased before anything runs, so it
// cannot crash at load. One whose names each carry their own `type`, `import { type A }`, is not:
// under verbatimModuleSyntax the module is still loaded, so it counts as a value import. A type-only
// import still makes the two modules depend on each other, so a cycle through one is a problem too,
// reported as type-only so the fix is plain: move the shared type to a module both sides can import.

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { listSourceFiles, moduleSpecifiers } from "../ListSourceFiles.ts";
import { readWorkspacePackages, reportProblems } from "../ReadWorkspacePackages.ts";

type ImportEdge = { readonly target: string; readonly isTypeOnly: boolean };
type ImportGraph = ReadonlyMap<string, readonly ImportEdge[]>;

const WORKSPACE_SCOPE = "@revisum/";

const toForwardSlashes = (path: string): string => path.replaceAll("\\", "/");

// Each workspace package's name, then its entry file, repository-relative.
function workspaceEntries(root: string): ReadonlyMap<string, string> {
    const entries = new Map<string, string>();
    for (const workspacePackage of readWorkspacePackages(root)) {
        if (typeof workspacePackage.manifest.name === "string") {
            entries.set(
                workspacePackage.manifest.name,
                `packages/${workspacePackage.folder}/src/index.ts`,
            );
        }
    }
    return entries;
}

// The source file a specifier names, or undefined when it names none of them.
function resolveSpecifier(
    file: string,
    specifier: string,
    files: ReadonlySet<string>,
    packages: ReadonlyMap<string, string>,
): string | undefined {
    if (specifier.startsWith(WORKSPACE_SCOPE)) {
        const entry = packages.get(specifier);
        return entry !== undefined && files.has(entry) ? entry : undefined;
    }
    if (!specifier.startsWith(".")) {
        return undefined;
    }
    const target = toForwardSlashes(normalize(join(dirname(file), specifier)));
    return files.has(target) ? target : undefined;
}

export function readImportGraph(root: string): ImportGraph {
    const files = listSourceFiles(root);
    const known = new Set(files);
    const packages = workspaceEntries(root);
    const graph = new Map<string, ImportEdge[]>();
    for (const file of files) {
        const edges: ImportEdge[] = [];
        for (const loaded of moduleSpecifiers(readFileSync(join(root, file), "utf8"))) {
            // A dynamic import or a require takes the module later, when it is called.
            if (loaded.clause === undefined) {
                continue;
            }
            const target = resolveSpecifier(file, loaded.specifier, known, packages);
            if (target !== undefined) {
                edges.push({ target, isTypeOnly: loaded.isTypeOnly });
            }
        }
        graph.set(file, edges);
    }
    return graph;
}

// The groups of files that can each reach every other, largest cycles first found by Tarjan's
// algorithm. Only groups that hold a cycle are kept: more than one file, or a file importing itself.
function stronglyConnectedGroups(
    graph: ImportGraph,
    follows: (edge: ImportEdge) => boolean,
): string[][] {
    const indexOf = new Map<string, number>();
    const lowest = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const groups: string[][] = [];
    let nextIndex = 0;

    const visit = (file: string): void => {
        indexOf.set(file, nextIndex);
        lowest.set(file, nextIndex);
        nextIndex += 1;
        stack.push(file);
        onStack.add(file);
        for (const edge of (graph.get(file) ?? []).filter(follows)) {
            if (!indexOf.has(edge.target)) {
                visit(edge.target);
                lowest.set(file, Math.min(lowest.get(file) ?? 0, lowest.get(edge.target) ?? 0));
            } else if (onStack.has(edge.target)) {
                lowest.set(file, Math.min(lowest.get(file) ?? 0, indexOf.get(edge.target) ?? 0));
            }
        }
        if (lowest.get(file) === indexOf.get(file)) {
            const group: string[] = [];
            let member: string | undefined;
            do {
                member = stack.pop();
                if (member !== undefined) {
                    onStack.delete(member);
                    group.push(member);
                }
            } while (member !== undefined && member !== file);
            const isImportingItself = (graph.get(file) ?? []).some(
                (edge) => follows(edge) && edge.target === file,
            );
            if (group.length > 1 || isImportingItself) {
                groups.push(group.toSorted());
            }
        }
    };

    for (const file of graph.keys()) {
        if (!indexOf.has(file)) {
            visit(file);
        }
    }
    return groups;
}

// A shortest chain of imports from one file of the group to another, within the group, or undefined
// when there is none. From a file to itself it is a shortest cycle through it.
function shortestChain(
    graph: ImportGraph,
    members: ReadonlySet<string>,
    from: string,
    to: string,
    follows: (edge: ImportEdge) => boolean,
): string[] | undefined {
    const cameFrom = new Map<string, string>();
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
        const file = queue[head] ?? "";
        for (const edge of (graph.get(file) ?? []).filter(follows)) {
            if (edge.target === to) {
                const chain = [file];
                for (let step = cameFrom.get(file); step !== undefined; step = cameFrom.get(step)) {
                    chain.unshift(step);
                }
                return [...chain, to];
            }
            if (members.has(edge.target) && !cameFrom.has(edge.target) && edge.target !== from) {
                cameFrom.set(edge.target, file);
                queue.push(edge.target);
            }
        }
    }
    return undefined;
}

// A shortest cycle through the group's first file, along the edges given.
function shortestCycle(
    graph: ImportGraph,
    group: readonly string[],
    follows: (edge: ImportEdge) => boolean,
): string[] {
    const start = group[0] ?? "";
    return shortestChain(graph, new Set(group), start, start, follows) ?? [start, start];
}

// A shortest cycle in the group that takes at least one type-only import: that import, then the
// shortest chain from the file it names back to the file that holds it.
function shortestCycleThroughTypeOnly(graph: ImportGraph, group: readonly string[]): string[] {
    const members = new Set(group);
    let shortest: string[] | undefined;
    for (const file of group) {
        for (const edge of graph.get(file) ?? []) {
            if (!edge.isTypeOnly || !members.has(edge.target)) {
                continue;
            }
            const back =
                edge.target === file
                    ? [file]
                    : shortestChain(graph, members, edge.target, file, () => true);
            const cycle = back === undefined ? undefined : [file, ...back];
            if (cycle !== undefined && (shortest === undefined || cycle.length < shortest.length)) {
                shortest = cycle;
            }
        }
    }
    return shortest ?? shortestCycle(graph, group, () => true);
}

const groupKey = (group: readonly string[]): string => group.join("\n");

export function findImportCycles(graph: ImportGraph): string[] {
    const isValueImport = (edge: ImportEdge): boolean => !edge.isTypeOnly;
    const isAnyImport = (): boolean => true;
    const problems: string[] = [];
    const valueGroups = new Set<string>();
    for (const group of stronglyConnectedGroups(graph, isValueImport)) {
        valueGroups.add(groupKey(group));
        problems.push(
            `import cycle: ${shortestCycle(graph, group, isValueImport).join(" -> ")}${describeGroup(group)}`,
        );
    }
    // A group that is exactly one value cycle is reported above; any other holds a type-only import.
    for (const group of stronglyConnectedGroups(graph, isAnyImport)) {
        if (!valueGroups.has(groupKey(group))) {
            problems.push(
                `import cycle through type-only imports: ${shortestCycleThroughTypeOnly(graph, group).join(" -> ")}${describeGroup(group)}; move the shared types to a module both sides can import`,
            );
        }
    }
    return problems;
}

const describeGroup = (group: readonly string[]): string =>
    group.length > 2 ? ` (${group.length} files reach each other: ${group.join(", ")})` : "";

export function checkImportCycles(root: string): string[] {
    return findImportCycles(readImportGraph(root));
}

if (import.meta.main) {
    process.exitCode = reportProblems("import cycle check", checkImportCycles(process.cwd()));
}
