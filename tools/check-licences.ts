// Checks that every package's `license` field matches its entry in licences.json, and that the
// licence text for each licence used is present at the repository root.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspacePackages, reportProblems } from './workspace-packages.ts';

type LicenceMap = {
  readonly licenceFiles: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, string>>;
};

export function checkLicences(root: string): string[] {
  const problems: string[] = [];
  const licenceMap: LicenceMap = JSON.parse(readFileSync(join(root, 'licences.json'), 'utf8'));
  const packages = readWorkspacePackages(root);

  for (const [licence, file] of Object.entries(licenceMap.licenceFiles)) {
    if (!existsSync(join(root, file))) problems.push(`licence text ${file} for ${licence} is missing`);
  }
  for (const workspacePackage of packages) {
    const expected = licenceMap.packages[workspacePackage.folder];
    const actual = workspacePackage.manifest.license;
    if (expected === undefined) {
      problems.push(`packages/${workspacePackage.folder} has no entry in licences.json`);
    } else if (!(expected in licenceMap.licenceFiles)) {
      problems.push(`licences.json gives packages/${workspacePackage.folder} the licence ${expected}, which has no licence file`);
    } else if (actual !== expected) {
      problems.push(`packages/${workspacePackage.folder}/package.json has license ${JSON.stringify(actual)}, licences.json says ${expected}`);
    }
  }
  for (const folder of Object.keys(licenceMap.packages)) {
    if (!packages.some((workspacePackage) => workspacePackage.folder === folder)) {
      problems.push(`licences.json lists ${folder}, which is not a folder under packages/`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('licence check', checkLicences(process.cwd()));
