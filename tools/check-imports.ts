// Keeps the trusted packages free of outside code. The compiler already rejects an import of a
// workspace package that a package's tsconfig.json does not reference; this check adds what the
// compiler cannot see: `contracts` and `engine` may import only Node built-ins, their own files
// and (for `engine`) `contracts`, and neither may declare a runtime dependency.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspacePackages, reportProblems, type WorkspacePackage } from './workspace-packages.ts';

// Package folder, then the workspace package folders it may import.
const TRUSTED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  contracts: [],
  engine: ['contracts'],
};

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

export function checkImports(root: string): string[] {
  const problems: string[] = [];
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
