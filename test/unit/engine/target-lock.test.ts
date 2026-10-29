// Locking the target matrix: `lock` pins each target's exact browser build by version and
// executable sha256, and `lockToFile` writes targets.lock.json only when every target locked, so a
// failed or refused lock leaves the existing file byte for byte as it was.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { adapterRegistry, canonicalJson, failure, lock, lockToFile, type TrustedProject } from '@revisum/engine';
import {
  builtAt, fakeBrowserBuild, fakeDriver, targetInput, trustedProjectWith, type BuildOutcome, type FakeBrowserBuild,
} from './target-examples.ts';

const LOCKFILE = 'targets.lock.json';

// Two targets, listed out of id order, so the file's sorting is visible.
const MATRIX = [
  targetInput('zeta-chromium', 'fake-chromium', 'chromium', 'desktop-1280'),
  targetInput('alpha-firefox', 'fake-firefox', 'firefox', 'desktop-1280'),
];

const temporaryFolders: string[] = [];
const builds: FakeBrowserBuild[] = [];
after(() => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true });
  for (const build of builds) build.remove();
});

const projectFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'revisum-target-lock-'));
  temporaryFolders.push(folder);
  return folder;
};

// A matrix whose two adapters report builds through `chromium` and `firefox`, which a test may
// change between locks.
type Setup = {
  readonly project: TrustedProject;
  readonly chromiumBuild: FakeBrowserBuild;
  readonly firefoxBuild: FakeBrowserBuild;
  chromium: () => BuildOutcome;
  firefox: () => BuildOutcome;
  registry(): ReturnType<typeof adapterRegistry>;
};

async function setup(): Promise<Setup> {
  const chromiumBuild = fakeBrowserBuild('chromium executable 156.0.7258.5');
  const firefoxBuild = fakeBrowserBuild('firefox executable 140.0.2');
  builds.push(chromiumBuild, firefoxBuild);
  const state: Setup = {
    project: await trustedProjectWith(MATRIX),
    chromiumBuild, firefoxBuild,
    chromium: () => builtAt('156.0.7258.5', chromiumBuild),
    firefox: () => builtAt('140.0.2', firefoxBuild),
    registry: () => adapterRegistry(new Map([
      ['fake-chromium', fakeDriver('fake-chromium', { build: () => state.chromium() })],
      ['fake-firefox', fakeDriver('fake-firefox', { build: () => state.firefox() })],
    ])),
  };
  return state;
}

const readBytes = (folder: string): Buffer => readFileSync(join(folder, LOCKFILE));

// A folder holding the lockfile a first, successful lock wrote, and that file's bytes.
async function lockedFolder(state: Setup): Promise<{ readonly folder: string; readonly bytes: Buffer }> {
  const folder = projectFolder();
  const locked = await lockToFile(folder, state.project, state.registry());
  assert.ok(locked.ok, `the first lock succeeds: ${JSON.stringify(locked)}`);
  return { folder, bytes: readBytes(folder) };
}

// ---- A successful lock: the positive control the failure tests compare against -----------------

describe('a successful lock', () => {
  test('pins each target by version and the sha256 of its executable, sorted by target id', { criterion: 'AC-SPEC-05-07' }, async () => {
    const state = await setup();
    const locked = await lock(state.project, state.registry(), []);
    assert.ok(locked.ok, JSON.stringify(locked));
    assert.deepEqual(locked.value, [
      { targetId: 'alpha-firefox', version: '140.0.2', executableSha256: state.firefoxBuild.sha256() },
      { targetId: 'zeta-chromium', version: '156.0.7258.5', executableSha256: state.chromiumBuild.sha256() },
    ]);
  });

  test('writes targets.lock.json as canonical JSON with a final newline, and leaves no temporary file', { criterion: 'AC-SPEC-05-07' }, async () => {
    const state = await setup();
    const { folder, bytes } = await lockedFolder(state);
    const text = bytes.toString('utf8');
    assert.ok(text.endsWith('}\n'), 'one final newline');
    const written: unknown = JSON.parse(text);
    assert.ok(typeof written === 'object' && written !== null && !Array.isArray(written));
    assert.equal(text, `${canonicalJson(written)}\n`, 'canonical JSON');
    assert.deepEqual(Object.keys(written).sort(), ['entries', 'schema']);
    assert.deepEqual(Reflect.get(written, 'entries'), [
      { targetId: 'alpha-firefox', version: '140.0.2', executableSha256: state.firefoxBuild.sha256() },
      { targetId: 'zeta-chromium', version: '156.0.7258.5', executableSha256: state.chromiumBuild.sha256() },
    ]);
    assert.deepEqual(readdirSync(folder), [LOCKFILE]);
  });

  test('re-locking unchanged builds rewrites the very same bytes', { criterion: 'AC-SPEC-05-07' }, async () => {
    const state = await setup();
    const { folder, bytes } = await lockedFolder(state);
    const again = await lockToFile(folder, state.project, state.registry());
    assert.ok(again.ok);
    assert.deepEqual(readBytes(folder), bytes);
  });

  test('counter-example: a successful re-lock to a new version does change the file, so the byte checks below can fail', { criterion: 'AC-SPEC-05-07' }, async () => {
    const state = await setup();
    const { folder, bytes } = await lockedFolder(state);
    const upgraded = fakeBrowserBuild('chromium executable 157.0.7300.0');
    builds.push(upgraded);
    state.chromium = () => builtAt('157.0.7300.0', upgraded);
    const relocked = await lockToFile(folder, state.project, state.registry());
    assert.ok(relocked.ok, JSON.stringify(relocked));
    assert.notDeepEqual(readBytes(folder), bytes);
  });
});

// ---- Download failure and offline --------------------------------------------------------------

describe('a lock that cannot get a build', () => {
  for (const code of ['lock-download-failed', 'lock-offline'] as const) {
    test(`${code}: the lock fails with that code and names the target`, { criterion: 'AC-SPEC-05-07' }, async () => {
      const state = await setup();
      state.firefox = () => failure({ code, detail: 'the build could not be fetched' });
      const locked = await lock(state.project, state.registry(), []);
      assert.ok(!locked.ok);
      assert.equal(locked.error.code, code);
      assert.equal(locked.error.targetId, 'alpha-firefox');
    });

    test(`${code}: the existing lockfile stays byte-identical, with no temporary file left`, { criterion: 'AC-SPEC-05-07' }, async () => {
      const state = await setup();
      const { folder, bytes } = await lockedFolder(state);
      // A new build to pin for one target, so a written file would differ, and a failure for the other.
      const upgraded = fakeBrowserBuild('chromium executable 157.0.7300.0');
      builds.push(upgraded);
      state.chromium = () => builtAt('157.0.7300.0', upgraded);
      state.firefox = () => failure({ code, detail: 'the build could not be fetched' });
      const locked = await lockToFile(folder, state.project, state.registry());
      assert.ok(!locked.ok);
      assert.equal(locked.error.code, code);
      assert.equal(locked.error.targetId, 'alpha-firefox', 'the failure names the target');
      assert.deepEqual(readBytes(folder), bytes, 'the lockfile is byte-identical');
      assert.deepEqual(readdirSync(folder), [LOCKFILE]);
    });

    test(`${code}: the failure names whichever target failed`, { criterion: 'AC-SPEC-05-07' }, async () => {
      const state = await setup();
      const { folder, bytes } = await lockedFolder(state);
      state.chromium = () => failure({ code, detail: 'the build could not be fetched' });
      const locked = await lockToFile(folder, state.project, state.registry());
      assert.ok(!locked.ok);
      assert.equal(locked.error.targetId, 'zeta-chromium');
      assert.deepEqual(readBytes(folder), bytes);
    });

    test(`${code}: with no lockfile yet, none is created`, { criterion: 'AC-SPEC-05-07' }, async () => {
      const state = await setup();
      const folder = projectFolder();
      state.chromium = () => failure({ code, detail: 'the build could not be fetched' });
      const locked = await lockToFile(folder, state.project, state.registry());
      assert.ok(!locked.ok);
      assert.equal(locked.error.code, code);
      assert.equal(existsSync(join(folder, LOCKFILE)), false);
      assert.deepEqual(readdirSync(folder), []);
    });
  }
});

// ---- Same version, different executable --------------------------------------------------------

describe('a re-lock that finds the same version with a different executable', () => {
  test('lock refuses with build-mismatch and names the target', { criterion: 'AC-SPEC-05-08' }, async () => {
    const state = await setup();
    const first = await lock(state.project, state.registry(), []);
    assert.ok(first.ok);
    state.chromiumBuild.replaceBytes('chromium executable 156.0.7258.5, rebuilt with other bytes');
    const relocked = await lock(state.project, state.registry(), first.value);
    assert.ok(!relocked.ok, 'the entry is not written');
    assert.equal(relocked.error.code, 'build-mismatch');
    assert.equal(relocked.error.targetId, 'zeta-chromium');
  });

  test('lockToFile leaves the lockfile byte-identical, keeping the old hash', { criterion: 'AC-SPEC-05-08' }, async () => {
    const state = await setup();
    const { folder, bytes } = await lockedFolder(state);
    const pinned = state.chromiumBuild.sha256();
    state.chromiumBuild.replaceBytes('chromium executable 156.0.7258.5, rebuilt with other bytes');
    const relocked = await lockToFile(folder, state.project, state.registry());
    assert.ok(!relocked.ok);
    assert.equal(relocked.error.code, 'build-mismatch');
    assert.equal(relocked.error.targetId, 'zeta-chromium');
    assert.deepEqual(readBytes(folder), bytes);
    assert.ok(bytes.toString('utf8').includes(pinned), 'the pinned hash is still the one on disk');
    assert.ok(!bytes.toString('utf8').includes(state.chromiumBuild.sha256()), 'the new hash was never written');
  });

  test('counter-example: the same version with the same executable re-locks to the same entries', { criterion: 'AC-SPEC-05-08' }, async () => {
    const state = await setup();
    const first = await lock(state.project, state.registry(), []);
    assert.ok(first.ok);
    const relocked = await lock(state.project, state.registry(), first.value);
    assert.ok(relocked.ok, JSON.stringify(relocked));
    assert.deepEqual(relocked.value, first.value);
  });

  test('counter-example: a new version with a new executable is pinned, not refused', { criterion: 'AC-SPEC-05-08' }, async () => {
    const state = await setup();
    const first = await lock(state.project, state.registry(), []);
    assert.ok(first.ok);
    const upgraded = fakeBrowserBuild('chromium executable 157.0.7300.0');
    builds.push(upgraded);
    state.chromium = () => builtAt('157.0.7300.0', upgraded);
    const relocked = await lock(state.project, state.registry(), first.value);
    assert.ok(relocked.ok, JSON.stringify(relocked));
    assert.deepEqual(relocked.value.find((entry) => entry.targetId === 'zeta-chromium'),
      { targetId: 'zeta-chromium', version: '157.0.7300.0', executableSha256: upgraded.sha256() });
  });
});
