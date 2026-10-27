// Checks the folder layout: source code lives only in packages/*/src and tools/, tests live
// only in the test folders, and every package has its source entry point, manifest, compiler
// configuration and README.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from './glob.ts';
import { readWorkspacePackages, reportProblems } from './workspace-packages.ts';

const SOURCE_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|mts|js|mjs)$/;
const SOURCE_FOLDERS = ['packages/*/src/**', 'tools/*.ts'];
// Test sites and recorded runs may hold scripts of their own.
const TEST_FOLDERS = ['test/**', 'proofs/**', 'fixtures/**', 'golden/**'];
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', '.idea', '.vscode', '.devcontainer', '.claude']);
const REQUIRED_PACKAGE_FILES = ['src/index.ts', 'package.json', 'tsconfig.json', 'README.md'];

function listFiles(root: string, folder = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function checkLayout(root: string): string[] {
  const problems: string[] = [];
  for (const file of listFiles(root)) {
    if (TEST_FILE.test(file) && !matchesAny(file, ['test/**'])) {
      problems.push(`${file} is a test outside test/`);
    } else if (SOURCE_EXTENSIONS.test(file) && !matchesAny(file, [...SOURCE_FOLDERS, ...TEST_FOLDERS])) {
      problems.push(`${file} is source code outside packages/*/src and tools/`);
    }
  }
  for (const workspacePackage of readWorkspacePackages(root)) {
    for (const required of REQUIRED_PACKAGE_FILES) {
      if (!existsSync(join(workspacePackage.path, required))) {
        problems.push(`packages/${workspacePackage.folder} is missing ${required}`);
      }
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('layout check', checkLayout(process.cwd()));
