// Runs every *.test.ts file under the given folders with Node's built-in test runner, with no
// retries. A folder that does not exist yet, or holds no tests, is reported and skipped, so the
// same scripts work before and after the first tests land.
//   node tools/run-test-folder.ts test/unit test/contract
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findTestFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...findTestFiles(path));
    else if (/\.test\.(ts|mts|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function main(folders: readonly string[]): number {
  const files: string[] = [];
  for (const folder of folders) {
    const found = findTestFiles(folder);
    if (found.length === 0) console.log(`no tests in ${folder} yet`);
    files.push(...found);
  }
  if (files.length === 0) return 0;
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  return run.status ?? 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
