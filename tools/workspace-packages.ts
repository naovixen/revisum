// Reads the workspace packages under packages/ and their manifests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManifest = {
  readonly name?: unknown;
  readonly license?: unknown;
  readonly dependencies?: unknown;
};

export type WorkspacePackage = {
  readonly folder: string;
  readonly path: string;
  readonly manifest: PackageManifest;
};

export function readWorkspacePackages(root: string): WorkspacePackage[] {
  const packagesPath = join(root, 'packages');
  return readdirSync(packagesPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(packagesPath, entry.name);
      const manifestPath = join(path, 'package.json');
      const manifest: PackageManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
      return { folder: entry.name, path, manifest };
    });
}

export function reportProblems(checkName: string, problems: readonly string[]): number {
  for (const problem of problems) console.error(`${checkName}: ${problem}`);
  console.log(problems.length === 0 ? `${checkName} passed` : `${checkName} failed: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}
