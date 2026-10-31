// Keeps the trusted packages free of outside code. The compiler already rejects an import of a
// workspace package that a package's tsconfig.json does not reference; this check adds what the
// compiler cannot see: `contracts` and `engine` may import only Node built-ins, their own files
// and (for `engine`) `contracts`, and neither may declare a runtime dependency.
//
// It also keeps route code to drafts. A plan-authoring route, such as the draft command, hands on
// a PlanDraft and nothing more, so it may not import the engine's run function (under any name)
// or the brand constructor, nor import the engine whole, where either could hide. (A Plan made by
// a cast is refused by tools/check-branded-casts.ts.)
// See docs/specs/SPEC-00-repo-seed-and-gates.md and docs/specs/SPEC-28-plan-authoring.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspacePackages, reportProblems, type WorkspacePackage } from './workspace-packages.ts';

// Package folder, then the workspace package folders it may import.
const TRUSTED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  contracts: [],
  engine: ['contracts'],
};

// The modules that are route code, by repository-relative path.
export const ROUTE_MODULES: readonly string[] = ['packages/cli/src/draft-command.ts'];
// What route code may not take from a workspace package: the run function and the brand constructor.
const NAMES_ROUTE_CODE_MAY_NOT_IMPORT = new Set(['run', 'brand']);
// `import { a, b as c } from '@revisum/…'` and `export { … } from '@revisum/…'`, type-only or not.
const NAMED_WORKSPACE_IMPORT = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@revisum\/[^'"]+)['"]/g;
// `import * as engine from '@revisum/…'`, `export * from '@revisum/…'`, a default import or a dynamic import.
const WHOLE_WORKSPACE_IMPORT = /\b(?:import\s+(?:type\s+)?(?:\*\s+as\s+[\w$]+|[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)|export\s+(?:type\s+)?\*(?:\s+as\s+[\w$]+)?)\s+from\s*['"](@revisum\/[^'"]+)['"]|\bimport\s*\(\s*['"](@revisum\/[^'"]+)['"]/g;

const IMPORT_SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function listSourceFiles(folder: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function packageName(workspacePackages: readonly WorkspacePackage[], folder: string): string {
  const name = workspacePackages.find((workspacePackage) => workspacePackage.folder === folder)?.manifest.name;
  return typeof name === 'string' ? name : folder;
}

// Each problem with a route module's imports: a forbidden name, or a workspace package imported whole.
export function checkRouteImports(root: string): string[] {
  const problems: string[] = [];
  for (const module of ROUTE_MODULES) {
    let source: string;
    try {
      source = readFileSync(join(root, module), 'utf8');
    } catch {
      problems.push(`${module} is listed as route code but does not exist`);
      continue;
    }
    for (const match of source.matchAll(NAMED_WORKSPACE_IMPORT)) {
      for (const entry of (match[1] ?? '').split(',')) {
        const imported = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '';
        if (NAMES_ROUTE_CODE_MAY_NOT_IMPORT.has(imported)) {
          problems.push(`${module} imports "${imported}" from ${match[2] ?? ''}; route code hands on drafts, so it may not import the run function or the brand constructor`);
        }
      }
    }
    for (const match of source.matchAll(WHOLE_WORKSPACE_IMPORT)) {
      problems.push(`${module} imports ${match[1] ?? match[2] ?? ''} whole; route code imports only the names it needs, so the run function cannot hide in it`);
    }
  }
  return problems;
}

export function checkImports(root: string): string[] {
  const problems: string[] = [...checkRouteImports(root)];
  const workspacePackages = readWorkspacePackages(root);

  for (const [folder, allowedFolders] of Object.entries(TRUSTED_PACKAGES)) {
    const workspacePackage = workspacePackages.find((candidate) => candidate.folder === folder);
    if (workspacePackage === undefined) {
      problems.push(`packages/${folder} is missing`);
      continue;
    }
    const dependencies = workspacePackage.manifest.dependencies;
    if (typeof dependencies === 'object' && dependencies !== null && Object.keys(dependencies).length > 0) {
      problems.push(`packages/${folder}/package.json declares runtime dependencies; it must have none`);
    }
    const allowedPackages = allowedFolders.map((allowed) => packageName(workspacePackages, allowed));
    for (const file of listSourceFiles(join(workspacePackage.path, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? '';
        const allowed = specifier.startsWith('node:') || specifier.startsWith('.') || allowedPackages.includes(specifier);
        if (!allowed) problems.push(`${file.slice(root.length + 1)} imports "${specifier}"; ${folder} may import only Node built-ins (node:…), its own files${allowedPackages.length > 0 ? ` and ${allowedPackages.join(', ')}` : ''}`);
      }
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('import check', checkImports(process.cwd()));
