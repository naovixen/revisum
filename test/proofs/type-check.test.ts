// Type-checks the whole test set, with the package sources it imports, under the strict settings.
// This is what makes the compile-time guarantee files count: each of their @ts-expect-error lines
// must still be an error.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';

test('the test set and the package sources it imports type-check strictly', { criterion: 'AC-SPEC-00-01', timeout: 300_000 }, () => {
  const compiler = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const checked = spawnSync(process.execPath, [compiler, '--noEmit', '-p', join(REPOSITORY_ROOT, 'test', 'tsconfig.json')], {
    encoding: 'utf8', timeout: 240_000,
  });
  assert.equal(checked.status, 0, (checked.stdout ?? '') + (checked.stderr ?? ''));
});
