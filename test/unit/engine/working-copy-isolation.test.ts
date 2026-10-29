// Core reads trusted files only from the protected branch, even when the change's own working copy
// is right there. Each test here runs with the working folder set to the change's working copy,
// whose trusted files differ from the protected branch's, and watches every file read Node's file
// system module makes. The loader and the verifier must give the protected-branch answer and read
// nothing from the working copy.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVERS_PATH, CODE_OWNERS_PATH, PROJECT_PATH, approversOf, assertRefused, loadForChange, memoryEventSink, withRepository,
  type FixtureRepository, type TestRepository,
} from './approval-repositories.ts';

const PRODUCTION_ORIGIN = 'https://shop.example.com';
const APPLICATION_CODE = 'src/signup.ts';

// Runs `body` with the working folder set to the repository's working copy, and returns the
// paths under the working copy that anything read through node:fs meanwhile.
async function readsFromWorkingCopy(repository: TestRepository, body: () => Promise<void>): Promise<string[]> {
  const root = resolve(repository.root);
  const spies = [
    mock.method(fs, 'readFileSync'), mock.method(fs, 'readFile'), mock.method(fs, 'openSync'), mock.method(fs, 'open'),
    mock.method(fs, 'createReadStream'), mock.method(fsPromises, 'readFile'), mock.method(fsPromises, 'open'),
  ];
  syncBuiltinESMExports();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await body();
    return spies.flatMap((spy) => spy.mock.calls.map((call) => call.arguments[0]))
      .filter((target): target is string | URL | Buffer => typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target))
      .map((target) => resolve(target instanceof URL ? fileURLToPath(target) : String(target)))
      .filter((path) => path.toLowerCase().startsWith(root.toLowerCase()));
  } finally {
    process.chdir(previous);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

// The working copy's version of a file, read before the working folder changes, to show it is there and differs.
const workingCopyText = (repository: TestRepository, path: string): string => fs.readFileSync(join(repository.root, path), 'utf8');

const widenProject = (fixture: FixtureRepository): void => {
  const project = structuredClone(fixture.protectedFiles[PROJECT_PATH]) as { origins: string[] };
  project.origins.push(PRODUCTION_ORIGIN);
  fixture.workingCopy[PROJECT_PATH] = project;
  fixture.workingCopy[APPLICATION_CODE] = 'export const signUp = () => fetch("/api/sign-up");\n';
};

test('the watch reports a read of a working-copy file, so an empty list means nothing was read', { criterion: 'AC-SPEC-02-02' }, async () => {
  // The control for every test below: a relative path read from the working folder is caught.
  await withRepository('solo', async (repository) => {
    const reads = await readsFromWorkingCopy(repository, async () => { await fsPromises.readFile(PROJECT_PATH, 'utf8'); });
    assert.equal(reads.length, 1, JSON.stringify(reads));
  }, widenProject);
});

// ---- project.json -----------------------------------------------------------------------------------

test('a project.json that is only in the reachable working copy is still refused as untrusted-source', { criterion: 'AC-SPEC-02-01' }, async () => {
  await withRepository('solo', async (repository) => {
    assert.ok(workingCopyText(repository, PROJECT_PATH).includes('origins'), 'the working copy has no project.json');
    let loaded: unknown;
    const reads = await readsFromWorkingCopy(repository, async () => {
      loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH], memoryEventSink());
    });
    assert.deepEqual(loaded, { ok: false, error: { code: 'untrusted-source', path: PROJECT_PATH } });
    assert.deepEqual(reads, []);
  }, (fixture) => {
    fixture.workingCopy[PROJECT_PATH] = fixture.protectedFiles[PROJECT_PATH];
    delete fixture.protectedFiles[PROJECT_PATH];
  });
});

test('with the edited project.json reachable in the working copy, core loads the protected-branch version and reads nothing from the working copy', { criterion: 'AC-SPEC-02-02' }, async () => {
  await withRepository('solo', async (repository) => {
    assert.ok(workingCopyText(repository, PROJECT_PATH).includes(PRODUCTION_ORIGIN), 'the working copy does not hold the edit');
    let origins: unknown;
    const reads = await readsFromWorkingCopy(repository, async () => {
      const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      if (loaded.ok) origins = loaded.value.project.origins;
    });
    assert.ok(!JSON.stringify(origins).includes(PRODUCTION_ORIGIN), 'the origin from the working copy was trusted');
    assert.deepEqual(reads, []);
  }, widenProject);
});

test('with an unedited working copy, the project loads the same from the same folder', { criterion: 'AC-SPEC-02-02' }, async () => {
  // The counter-example: the folder and the watch are the same, and the load succeeds.
  await withRepository('solo', async (repository) => {
    const reads = await readsFromWorkingCopy(repository, async () => {
      const loaded = await loadForChange(repository.versionControl(), [], memoryEventSink());
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
    });
    assert.deepEqual(reads, []);
  });
});

// ---- The code-owners file and approvers.json ----------------------------------------------------------

test('with an edited code-owners file reachable in the working copy, its new owner still gets not-code-owner', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('team', async (repository) => {
    assert.ok(workingCopyText(repository, CODE_OWNERS_PATH).includes('/plans/ @reviewer-linus'), 'the working copy does not hold the edit');
    const reads = await readsFromWorkingCopy(repository, async () => {
      assertRefused(repository, await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-linus')), 'not-code-owner');
    });
    assert.deepEqual(reads, []);
  }, (fixture) => {
    fixture.workingCopy[CODE_OWNERS_PATH] = `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/plans/ @reviewer-linus\n`;
    fixture.pullRequests['12']?.changedFiles.push({ path: CODE_OWNERS_PATH, authors: ['dev-ada'] });
  });
});

test('with an edited approvers.json reachable in the working copy, its new maintainer still gets not-maintainer', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('solo', async (repository) => {
    assert.ok(workingCopyText(repository, APPROVERS_PATH).includes('build-agent'), 'the working copy does not hold the edit');
    const reads = await readsFromWorkingCopy(repository, async () => {
      const proof = repository.lockdownProof({ commit: 'commit-agent-merge', mergedBy: 'build-agent' });
      assertRefused(repository, await repository.verify(repository.subject('plan'), proof), 'not-maintainer');
    });
    assert.deepEqual(reads, []);
  }, (fixture) => {
    const edited = structuredClone(approversOf(fixture));
    if (edited.agentLockdown !== undefined) edited.agentLockdown.maintainer = 'build-agent';
    fixture.workingCopy[APPROVERS_PATH] = edited;
    fixture.landings.push({ commit: 'commit-agent-merge', branch: 'main', login: 'build-agent', type: 'user', at: '2026-10-25T09:00:00Z' });
  });
});

test("the maintainer's own merge verifies from the same working folder", { criterion: 'AC-SPEC-02-12' }, async () => {
  // The counter-example: the watch and the folder are the same, and the protected-branch maintainer approves.
  await withRepository('solo', async (repository) => {
    const reads = await readsFromWorkingCopy(repository, async () => {
      const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
      assert.equal(verified.ok, true, JSON.stringify(verified));
    });
    assert.deepEqual(reads, []);
  });
});
